import { expect, test } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { seedResearch } from '../fixtures/libraryResearch'
import { gotoModule } from '../helpers/nav'

test('实际模块往返保留文献项目、关键词和列表位置', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => seedResearch(seed).seed })
  try {
    const { page } = ctx
    await gotoModule(page, 'library')
    await page.locator('button[title="合成研究课题"]').click()
    const local = page.getByRole('searchbox', { name: '库内检索' })
    await local.fill('研究文献1')
    await expect(page.getByRole('heading', { name: '研究文献1', exact: true })).toBeVisible()
    await gotoModule(page, 'assets'); await gotoModule(page, 'library')
    await expect(local).toHaveValue('研究文献1')
    await page.getByRole('button', { name: '清除库内检索', exact: true }).click()
    const list = page.getByRole('region', { name: '文献浏览列表', exact: true })
    await list.evaluate(element => { element.scrollTop = 250 })
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    const top = await list.evaluate(element => element.scrollTop)
    await gotoModule(page, 'assets'); await gotoModule(page, 'library')
    await expect.poll(() => list.evaluate((element, expected) => Math.abs(element.scrollTop - expected), top)).toBeLessThan(2)
  } finally { await ctx.cleanup() }
})

test('矩阵内容返回后恢复位置与筛选，而非对加载占位提前夹紧', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => seedResearch(seed).seed })
  try {
    const { page } = ctx
    await gotoModule(page, 'library')
    await page.locator('button[title="合成研究课题"]').click()
    await page.getByRole('button', { name: '证据比较矩阵', exact: true }).click()
    await page.getByLabel('证据关键词', { exact: true }).fill('合成证据')
    await expect(page.getByRole('button', { name: '刷新矩阵', exact: true })).toBeEnabled()
    await expect(page.getByRole('table', { name: '证据比较表' }).locator('tbody tr')).toHaveCount(10)
    const list = page.getByRole('region', { name: '文献浏览列表', exact: true })
    await list.evaluate(element => { element.scrollTop = 300 })
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
    const top = await list.evaluate(element => element.scrollTop)
    await gotoModule(page, 'assets'); await gotoModule(page, 'library')
    await expect(page.getByLabel('证据关键词', { exact: true })).toHaveValue('合成证据')
    await expect(page.getByRole('table', { name: '证据比较表' }).locator('tbody tr')).toHaveCount(10)
    await expect.poll(() => list.evaluate((element, expected) => Math.abs(element.scrollTop - expected), top)).toBeLessThan(2)
  } finally { await ctx.cleanup() }
})
