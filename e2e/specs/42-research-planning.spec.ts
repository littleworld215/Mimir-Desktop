import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('科研计划：空库、新建项目、看板、归档、回收站及深浅窄屏', async () => {
  test.setTimeout(180_000)
  let root = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { root = seed.workspaces[0]!.path; return seed } })
  try {
    await gotoModule(ctx.page, 'planning')
    const { page } = ctx
    await expect(page.getByText('当前没有匹配的科研计划。', { exact: true })).toBeVisible()
    expect(existsSync(join(root, '.mimir/planning/planning.json'))).toBe(false)
    await page.getByRole('button', { name: '新建科研项目', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('合成研究项目')
    await page.getByLabel('正文', { exact: true }).fill('  项目正文\n\n## 下一步\n人工整理资料\n')
    await page.getByLabel('项目分类', { exact: true }).selectOption('vertical')
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(page.getByRole('button', { name: '合成研究项目', exact: true })).toBeVisible()
    const path = join(root, '.mimir/planning/planning.json')
    const readDocument = () => JSON.parse(readFileSync(path, 'utf8'))
    expect(readDocument().items[0].content).toBe('  项目正文\n\n## 下一步\n人工整理资料\n')
    await page.getByRole('button', { name: '项目看板', exact: true }).click()
    await page.getByLabel('调整合成研究项目状态', { exact: true }).selectOption('paused')
    await expect.poll(() => readDocument().items[0].status).toBe('paused')
    const screenshots = join(process.cwd(), '../../.local/i10-execution/visual'); mkdirSync(screenshots, { recursive: true })
    for (const dark of [false, true]) for (const width of [1280, 800]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await page.setViewportSize({ width, height: 900 })
      await expect(page.getByRole('button', { name: '合成研究项目', exact: true })).toBeInViewport()
      await page.screenshot({ path: join(screenshots, `batch2-${dark ? 'dark' : 'light'}-${width}.png`) })
    }
    await page.getByRole('button', { name: '归档', exact: true }).click()
    await expect(page.getByText('当前没有匹配的科研计划。', { exact: true })).toBeVisible()
    await page.getByLabel('归档范围', { exact: true }).selectOption('only')
    await expect(page.getByRole('button', { name: '合成研究项目', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '移入回收站', exact: true }).click()
    await page.getByRole('button', { name: '查看回收站', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复记录', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '恢复记录', exact: true }).click()
    await expect.poll(() => readDocument().items[0].deleted).toBe(false)
  } finally { await ctx.cleanup() }
})

test('科研计划复用统一离开守卫：取消保留输入，明确丢弃才能导航', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    const { page } = ctx
    await gotoModule(page, 'planning')
    await page.getByRole('button', { name: '新建科研项目', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('尚未保存的合成项目')
    await page.getByRole('button', { name: '总览', exact: true }).first().click()
    const guard = page.getByRole('dialog', { name: '存在未保存的研究资料编辑', exact: true })
    await expect(guard).toBeVisible()
    await guard.getByRole('button', { name: '留在这里', exact: true }).click()
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('尚未保存的合成项目')
    await page.getByRole('button', { name: '总览', exact: true }).first().click()
    await guard.getByRole('button', { name: '丢弃后离开', exact: true }).click()
    await expect(page.getByRole('form', { name: '编辑科研计划', exact: true })).toHaveCount(0)
  } finally { await ctx.cleanup() }
})
