// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EvidenceHistory } from '../../../src/components/modules/library/evidence/EvidenceHistory'
import { PaperReader } from '../../../src/components/modules/library/PaperReader'
import { document as evidenceDocument, version } from './fixtures'
afterEach(cleanup)
it('历史全部版本只读，未截断摘录，打开指定历史来源', () => {
  const card = evidenceDocument().cards[0]!, open = vi.fn()
  card.currentVersion = 2; card.versions.push({ ...version(), version: 2, quote: '新摘录' })
  render(<EvidenceHistory card={card} onOpenSource={open} />)
  fireEvent.change(screen.getByLabelText('查看证据版本'), { target: { value: '1' } })
  expect(screen.getByTestId('evidence-history-quote').textContent).toBe(version().quote)
  expect(document.querySelector('input,textarea')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '打开此版本来源' }))
  expect(open).toHaveBeenCalledWith(1)
})
it('阅读器保留原笔记页签和新增证据入口，不自动转换笔记', () => {
  render(<PaperReader paper={{ arxivId: 'paper-1', title: '文献', authors: [], summary: '', url: '', notes: '[2026-10-17 10:00]\n旧阅读笔记', tags: [], projectIds: [], addedAt: '' }} onClose={() => {}} onUpdateNotes={vi.fn()} onOpenExternal={() => {}} />)
  expect(screen.getByRole('tab', { name: '阅读笔记' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: '证据卡' })).toBeTruthy()
  expect(screen.getByText('旧阅读笔记')).toBeTruthy()
})
