import { expect, test } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
import { seedResearchWorkflow } from '../fixtures/researchWorkflow'

test('默认弹窗在双向主题切换期间保持对比度、开合动画与焦点，兼容减少动效', async () => {
  test.setTimeout(90_000)
  const ctx = await launchApp({
    executablePath: process.env.MIMIR_E2E_PACKAGED,
    transformSeed: seed => seedResearchWorkflow(seed).seed
  })
  try {
    const { page } = ctx
    await gotoModule(page, 'library')
    await page.locator('button[title="合成科研闭环"]').click()
    await page.getByRole('button', { name: '证据卡：闭环文献1', exact: true }).click()
    const reader = page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
    await reader.getByLabel('填写框架', { exact: true }).selectOption('t2i-fairness')
    const trigger = reader.getByRole('button', { name: '预览空白填写提纲', exact: true })
    const modal = page.getByRole('dialog', { name: '插入填写提纲预览', exact: true })
    for (const motion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion: motion })
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await trigger.click()
      await expect(modal).toBeVisible()
      const animation = await modal.evaluate(element => {
        const style = getComputedStyle(element)
        return { name: style.animationName, duration: parseFloat(style.animationDuration) }
      })
      expect(animation.name).not.toBe('none')
      if (motion === 'reduce') expect(animation.duration).toBeLessThanOrEqual(0.00001)
      else expect(animation.duration).toBeGreaterThan(0)
      await modal.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})))
      })
      for (const dark of [true, false]) {
        const samples = await modal.getByRole('heading', { name: '插入填写提纲预览', exact: true }).evaluate(
          async (heading, dark) => {
            const panel = heading.closest('[role="dialog"]')!
            const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
              .map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
              .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0)
            getComputedStyle(panel).backgroundColor
            document.documentElement.classList.toggle('dark', dark)
            getComputedStyle(panel).backgroundColor
            // Measure at a rendering-frame boundary: the preserved reduced-motion
            // rule also gives ancestors a 0.01ms transition, which must not be
            // mistaken for a displayed frame by sequential same-task style reads.
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
            getComputedStyle(heading).color
            // Freeze actual CSS color transitions at deterministic intermediate times;
            // this catches the old implicit transition without racing a 200ms frame.
            const transitions = panel.getAnimations({ subtree: true }).filter(a =>
              a instanceof CSSTransition && /color/i.test(a.transitionProperty))
            transitions.forEach(a => a.pause())
            const samples = [0, 0.3, 0.6, 1].map(fraction => {
              transitions.forEach(a => { a.currentTime = Number(a.effect!.getTiming().duration) * fraction })
              const foreground = getComputedStyle(heading).color
              const background = getComputedStyle(panel).backgroundColor
              const a = luminance(foreground), b = luminance(background)
              return { fraction, foreground, background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
            })
            transitions.forEach(a => a.finish())
            return samples
          }, dark)
        await test.info().attach(`${motion}-${dark ? 'dark' : 'light'}-contrast`, {
          body: JSON.stringify(samples, null, 2), contentType: 'application/json'
        })
        for (const sample of samples) expect(sample.contrast).toBeGreaterThanOrEqual(4.5)
        const buttonContrast = await modal.getByRole('button', { name: '仅插入空字段', exact: true }).evaluate(element => {
          const style = getComputedStyle(element)
          const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
            .map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
            .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0)
          const a = luminance(style.color), b = luminance(style.backgroundColor)
          return { foreground: style.color, background: style.backgroundColor, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
        })
        await test.info().attach(`${motion}-${dark ? 'dark' : 'light'}-button-contrast`, {
          body: JSON.stringify(buttonContrast), contentType: 'application/json'
        })
        expect(buttonContrast.contrast).toBeGreaterThanOrEqual(4.5)
        await modal.screenshot({ path: test.info().outputPath(`${motion}-${dark ? 'dark' : 'light'}.png`) })
      }
      await modal.evaluate(element => {
        const target = window as typeof window & { __dialogThemeExit?: { name: string; duration: number } }
        delete target.__dialogThemeExit
        element.addEventListener('animationstart', event => {
          if (event.target !== element || element.getAttribute('data-state') !== 'closed') return
          const style = getComputedStyle(element)
          target.__dialogThemeExit = { name: style.animationName, duration: parseFloat(style.animationDuration) }
        }, { once: true })
      })
      await modal.getByRole('button', { name: '取消插入', exact: true }).click()
      const exitAnimation = () => page.evaluate(() => (window as typeof window & {
        __dialogThemeExit?: { name: string; duration: number }
      }).__dialogThemeExit)
      await expect.poll(exitAnimation, { timeout: 1000 }).toBeTruthy()
      const exit = (await exitAnimation())!
      expect(exit.name).not.toBe('none')
      if (motion === 'reduce') expect(exit.duration).toBeLessThanOrEqual(0.00001)
      else expect(exit.duration).toBeGreaterThan(0)
      await expect(modal).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
  } finally {
    try {
      if (!ctx.page.isClosed()) {
        await expect.poll(() => ctx.page.evaluate(async () => await window.mimirRequestEvidenceLeave?.('discard') ?? true), {
          timeout: 5000
        }).toBe(true)
      }
    } finally {
      await ctx.cleanup()
    }
  }
})
