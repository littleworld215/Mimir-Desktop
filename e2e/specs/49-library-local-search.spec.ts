import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('文献库：本地关键词与项目组合筛选，清除恢复；无需发起联网搜索', async ({}, testInfo) => {
  const ctx = await launchApp({
    executablePath: process.env.MIMIR_E2E_PACKAGED,
    transformSeed: seed => {
      const workspace = seed.spaceData ?? {}
      const first = { arxivId: '2601.00001v2', title: '合成 Fairness Study', authors: ['Alice'], summary: '多语言', notes: '评价器独立需复核', tags: ['culture'], projectIds: ['local-project'], url: 'https://example.org/first', addedAt: '2026-10-21' }
      const second = { ...first, arxivId: 'doi:10.1/other', title: '合成 Ocean Study', authors: ['Bob'], notes: '', tags: [], projectIds: [] }
      return { ...seed, spaceData: { ...workspace, 'library:papers': { [first.arxivId]: first, [second.arxivId]: second }, 'library:projects': [{ id: 'local-project', title: '本地筛选课题', createdAt: '', updatedAt: '' }] } }
    }
  })
  try {
    await gotoModule(ctx.page, 'library')
    const local = ctx.page.getByRole('searchbox', { name: '库内检索', exact: true })
    await expect(ctx.page.getByRole('heading', { name: '合成 Ocean Study' })).toBeVisible()
    const firstHeading = ctx.page.getByRole('heading', { name: '合成 Fairness Study' })
    await firstHeading.click()
    const card = firstHeading.locator('xpath=ancestor::div[contains(@class,"group")][1]')
    await card.getByRole('button', { name: '编辑', exact: true }).first().click()
    await card.getByPlaceholder('逗号分隔，如 survey, llm').fill('未保存的标签')
    await card.getByRole('button', { name: '编辑', exact: true }).first().click()
    await card.getByPlaceholder('写下你的阅读笔记...').fill('未保存的笔记')
    await local.fill('无匹配结果')
    await expect(firstHeading).toBeHidden()
    await ctx.page.getByRole('button', { name: '清除库内检索' }).click()
    await expect(card.getByPlaceholder('逗号分隔，如 survey, llm')).toHaveValue('未保存的标签')
    await expect(card.getByPlaceholder('写下你的阅读笔记...')).toHaveValue('未保存的笔记')
    await card.getByRole('button', { name: '取消', exact: true }).first().click()
    await card.getByRole('button', { name: '取消', exact: true }).first().click()
    await local.fill('ＦＡＩＲＮＥＳＳ  评价器')
    await expect(ctx.page.getByRole('heading', { name: '合成 Fairness Study' })).toBeVisible()
    await expect(ctx.page.getByRole('heading', { name: '合成 Ocean Study' })).toHaveCount(0)
    await expect(ctx.page.getByPlaceholder('搜索 arXiv 论文...')).toHaveValue('')
    await ctx.page.getByRole('button', { name: '清除库内检索' }).click()
    await ctx.page.getByTitle('本地筛选课题', { exact: true }).click()
    await local.fill('Ocean')
    await expect(ctx.page.getByText('当前筛选没有匹配的文献', { exact: true })).toBeVisible()
    await ctx.page.getByTitle('全部项目', { exact: true }).click()
    await expect(ctx.page.getByRole('heading', { name: '合成 Ocean Study' })).toBeVisible()
    await ctx.page.getByRole('button', { name: '清除库内检索' }).click()
    await expect(ctx.page.getByRole('heading', { name: '合成 Fairness Study' })).toBeVisible()
    const stored = await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())
    expect(stored.papers).toHaveLength(2)
    expect((stored.papers as Array<{ arxivId: string; notes: string }>).find(p => p.arxivId === '2601.00001v2')!.notes).toBe('评价器独立需复核')
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 900))
    await ctx.page.evaluate(() => document.documentElement.classList.remove('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('local-search-light-800.png'), animations: 'disabled' })
    await ctx.page.evaluate(() => document.documentElement.classList.add('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('local-search-dark-800.png'), animations: 'disabled' })
  } finally { await ctx.cleanup() }
})
