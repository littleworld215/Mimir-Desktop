import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addCalendarDays, localPlanningDate } from '../../shared/researchPlanningDates'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('科研计划：项目下一步、显式我的一天、完成与按当前范围回收', async () => {
  test.setTimeout(180_000)
  let root = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { root = seed.workspaces[0]!.path; return seed } })
  try {
    const { page } = ctx, today = localPlanningDate()
    await gotoModule(page, 'planning')
    await page.getByRole('button', { name: '新建科研项目', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('合成课题')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await page.getByRole('button', { name: '添加项目待办', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('课题下一步')
    await page.getByLabel('截止日期', { exact: true }).fill(today)
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '课题下一步', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '待办', exact: true }).click()
    await expect(page.getByText('当前没有匹配的科研计划。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '全部待办', exact: true }).click()
    await page.getByRole('button', { name: '安排到我的一天', exact: true }).click()
    await page.getByRole('button', { name: '我的一天', exact: true }).click()
    await expect(page.getByRole('button', { name: '课题下一步', exact: true })).toBeVisible()
    // 完成后条目退出当前筛选，不等待已经移除的checkbox保持checked。
    await page.getByRole('checkbox', { name: '完成课题下一步', exact: true }).click()
    await expect(page.getByText('当前没有匹配的科研计划。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '已完成待办', exact: true }).click()
    await expect(page.getByRole('button', { name: '课题下一步', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '当前分组/类型已完成移入回收站', exact: true }).click()
    const file = join(root, '.mimir/planning/planning.json')
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).items.find((i: { title: string }) => i.title === '课题下一步').deleted).toBe(true)
    await page.getByRole('button', { name: '查看回收站', exact: true }).click()
    await page.getByRole('button', { name: '恢复记录', exact: true }).click()
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).items.find((i: { title: string }) => i.title === '课题下一步').deleted).toBe(false)
  } finally { await ctx.cleanup() }
})

test('科研计划：周期完成一次派生、撤销再完成不重复', async () => {
  test.setTimeout(180_000)
  let root = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { root = seed.workspaces[0]!.path; return seed } })
  try {
    const { page } = ctx, today = localPlanningDate(), oldDue = addCalendarDays(today, -20)
    await gotoModule(page, 'planning')
    await page.getByRole('button', { name: '待办', exact: true }).click()
    await page.getByRole('button', { name: '新建待办', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('每日阅读')
    await page.getByLabel('截止日期', { exact: true }).fill(oldDue)
    await page.getByLabel('重复规则', { exact: true }).selectOption('daily')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await page.getByRole('checkbox', { name: '完成每日阅读', exact: true }).click()
    const read = () => JSON.parse(readFileSync(join(root, '.mimir/planning/planning.json'), 'utf8'))
    await expect.poll(() => read().items.length).toBe(2)
    const child = read().items.find((i: { recurrenceParentId?: string }) => i.recurrenceParentId)
    expect(child.dueDate).toBe(addCalendarDays(today, 1)); expect(child.myDay).toBeNull()
    await page.getByRole('button', { name: '已完成待办', exact: true }).click()
    await page.getByRole('checkbox', { name: '完成每日阅读', exact: true }).click()
    await page.getByRole('button', { name: '全部待办', exact: true }).click()
    await page.locator('article').filter({ hasText: `截止：${oldDue}` }).getByRole('checkbox', { name: '完成每日阅读', exact: true }).click()
    await expect.poll(() => read().items.length).toBe(2)
  } finally { await ctx.cleanup() }
})

test('科研计划：真实周/月日程、日期详情和总览跳转', async () => {
  test.setTimeout(180_000)
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    const { page } = ctx, today = localPlanningDate()
    await gotoModule(page, 'planning')
    await page.getByRole('button', { name: '日程', exact: true }).click()
    await page.getByRole('button', { name: `添加${today}日程`, exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('合成日程')
    await page.getByRole('checkbox', { name: '全天日程', exact: true }).uncheck()
    await page.getByLabel('开始时间', { exact: true }).fill('10:00')
    await page.getByLabel('结束时间', { exact: true }).fill('11:00')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '10:00 合成日程', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '月历', exact: true }).click()
    await page.getByRole('button', { name: `查看${today}日程`, exact: true }).click()
    await expect(page.getByRole('heading', { name: `日期详情：${today}`, exact: true })).toBeVisible()
    const directory = join(process.cwd(), '../../.local/i10-execution/visual'); mkdirSync(directory, { recursive: true })
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await page.setViewportSize({ width: 800, height: 1000 })
      await page.screenshot({ path: join(directory, `batch3-calendar-${dark ? 'dark' : 'light'}-800.png`) })
    }
    await page.getByRole('button', { name: '周列表', exact: true }).click()
    await expect(page.getByRole('button', { name: '合成日程', exact: true })).toBeVisible()
    await gotoModule(page, 'overview')
    await page.getByRole('button', { name: '本周日程 1', exact: true }).click()
    await expect(page.getByRole('region', { name: '科研日程日历', exact: true })).toBeVisible()
    await expect(page.getByLabel('日历定位日期', { exact: true })).toHaveValue(today)
  } finally { await ctx.cleanup() }
})
