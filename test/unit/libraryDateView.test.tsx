// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PaperCard } from '../../src/components/modules/library/PaperCard'
import { formatDate } from '../../src/components/modules/library/types'

afterEach(cleanup)
it('搜索结果只知年份时不显示一月，空值不显示Invalid Date', () => {
  expect(formatDate('2024')).toBe('2024年（仅年份）')
  expect(formatDate('')).toBe('未知')
})
const paper = { arxivId: 'synthetic', title: 'Dates', authors: [], summary: '', url: '', notes: '', tags: [], projectIds: [], addedAt: '2026-10-22T00:00:00Z' }
function show(extra = {}) {
  return render(<PaperCard paper={{ ...paper, ...extra }} projects={[]} selectedProjectId={null}
    onUpdate={vi.fn()} onRemove={vi.fn()} onDownloadPdf={vi.fn()} onOpenPdf={vi.fn()}
    onOpenExternal={vi.fn()} onScoreRelevance={vi.fn()} onExportBib={vi.fn()} />)
}
it('卡片明确区分初始提交、更新、来源出版和入库，年份不补月日', () => {
  show({ dates: {
    arxivSubmitted: { value: '2024-05-06T23:00:00Z', precision: 'instant', source: 'arxiv' },
    arxivUpdated: { value: '2025-06-07', precision: 'day', source: 'arxiv' },
    sourcePublished: { value: '2025', precision: 'year', source: 'openalex' }
  } })
  expect(screen.getByText('arXiv初始提交：2024-05-06')).toBeTruthy()
  expect(screen.getByText('arXiv版本更新：2025-06-07')).toBeTruthy()
  expect(screen.getByText('来源出版：2025（仅年份）')).toBeTruthy()
  expect(screen.getByText(/入库：/)).toBeTruthy()
})
it('旧记录显示来源日期未知，不把入库时间当出版时间', () => {
  show()
  expect(screen.getByText('来源日期：未知')).toBeTruthy()
  expect(screen.getByText(/入库：/)).toBeTruthy()
})
