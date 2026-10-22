import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('真实入库保留日期精度、跨来源语义且不猜填旧文献', async ({}, testInfo) => {
  const legacy = { arxivId: 'legacy', title: '合成旧文献', authors: [], summary: '', url: '', notes: '旧笔记', tags: [], projectIds: [], addedAt: '2020-01-01' }
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED,
    transformSeed: seed => ({ ...seed, spaceData: { ...seed.spaceData, 'library:papers': { legacy } } }) })
  try {
    const imported = await ctx.page.evaluate(async () => {
      const api = window.electronAPI!.library
      const entry = { id: 'synthetic-dates', title: '合成日期文献', authors: ['Synthetic'], summary: '', url: 'https://example.org', published: '2024-05-06T23:00:00Z', updated: '2025-06-07T10:00:00Z', source: 'arxiv' as const }
      const results = [await api.importPaper(entry), await api.importPaper({ ...entry, source: 'openalex', published: '2025' })]
      return { results, papers: (await api.listPapers()).papers }
    })
    expect(imported.results.every(result => result.ok)).toBe(true)
    expect(imported.papers).toContainEqual(legacy)
    expect(imported.papers).toContainEqual(expect.objectContaining({ arxivId: 'synthetic-dates', dates: {
      arxivSubmitted: { value: '2024-05-06T23:00:00Z', precision: 'instant', source: 'arxiv' },
      arxivUpdated: { value: '2025-06-07T10:00:00Z', precision: 'instant', source: 'arxiv' },
      sourcePublished: { value: '2025', precision: 'year', source: 'openalex' }
    } }))
    await gotoModule(ctx.page, 'library')
    await expect(ctx.page.getByText('arXiv初始提交：2024-05-06')).toBeVisible()
    await expect(ctx.page.getByText('arXiv版本更新：2025-06-07')).toBeVisible()
    await expect(ctx.page.getByText('来源出版：2025（仅年份）')).toBeVisible()
    await expect(ctx.page.getByText('来源日期：未知')).toBeVisible()
    await ctx.page.screenshot({ path: testInfo.outputPath('dates-light.png'), animations: 'disabled' })
    await ctx.page.evaluate(() => document.documentElement.classList.add('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('dates-dark.png'), animations: 'disabled' })
  } finally { await ctx.cleanup() }
})
