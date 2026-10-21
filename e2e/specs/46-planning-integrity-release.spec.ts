import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('科研计划：普通编辑器取消及保存后恢复可操作入口，筛走的记录回退新建', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    await gotoModule(ctx.page, 'planning')
    const create = ctx.page.getByRole('button', { name: '新建科研项目', exact: true })
    await create.click()
    await ctx.page.getByRole('button', { name: '取消编辑', exact: true }).click()
    await expect(create).toBeFocused()
    await create.click()
    await ctx.page.getByLabel('标题', { exact: true }).fill('焦点回归课题')
    await ctx.page.getByLabel('状态', { exact: true }).selectOption('planned')
    await ctx.page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(create).toBeFocused()
    const title = ctx.page.getByRole('button', { name: '焦点回归课题', exact: true })
    await title.click()
    await ctx.page.keyboard.press('Escape')
    await expect(title).toBeFocused()
    await ctx.page.getByLabel('筛选状态', { exact: true }).selectOption('planned')
    await title.click()
    await ctx.page.getByLabel('状态', { exact: true }).selectOption('done')
    await ctx.page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(title).toHaveCount(0)
    await expect(create).toBeFocused()
  } finally { await ctx.cleanup() }
})

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
