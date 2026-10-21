import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('科研计划：系统减少动效时导入对话无缩放滑入，关闭后恢复入口焦点', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    await ctx.page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoModule(ctx.page, 'planning')
    const entry = ctx.page.getByRole('button', { name: '导入与导出', exact: true }); await entry.click()
    const modal = ctx.page.getByRole('dialog', { name: '科研计划导入与导出', exact: true })
    await expect(modal).toBeVisible()
    const durations = await modal.evaluate(element => { const style = getComputedStyle(element); return { animation: style.animationDuration, transition: style.transitionDuration, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches } })
    expect(durations.reduced).toBe(true)
    const seconds = (value: string) => value.split(',').map(v => v.trim().endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v))
    expect(Math.max(...seconds(durations.animation), ...seconds(durations.transition))).toBeLessThanOrEqual(0.001)
    await ctx.page.keyboard.press('Escape'); await expect(modal).toHaveCount(0)
    // Trigger is outside Radix's own Trigger, so the planning module restores it.
    await expect(entry).toBeFocused()
  } finally {
    // Close this test's idle modal before normal shutdown; an open exchange is
    // intentionally busy and the product must not discard it behind the guard.
    if (!ctx.page.isClosed()) await ctx.page.keyboard.press('Escape').catch(() => {})
    await ctx.cleanup()
  }
})
