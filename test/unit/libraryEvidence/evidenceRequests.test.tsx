// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EvidencePanel } from '../../../src/components/modules/library/evidence/EvidencePanel'
import { fields, document as evidenceDocument } from './fixtures'
afterEach(cleanup)
it('迟到的无scope初始读取不能为新文献页授予旧scope或恢复旧内容', async () => {
  const pending: ((value: unknown) => void)[] = []
  const list = vi.fn(() => new Promise(resolve => pending.push(resolve)))
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { libraryEvidence: { list } } })
  const view = render(<EvidencePanel paperId="old" onOpenSource={() => {}} />)
  await waitFor(() => expect(pending.length).toBe(1))
  view.rerender(<EvidencePanel paperId={fields().paperId} onOpenSource={() => {}} />)
  await waitFor(() => expect(pending.length).toBe(2))
  await act(async () => { pending[0]!({ ok: true, scope: { workspaceId: 'old', spaceEpoch: 'old' }, revision: 99, rows: [], total: 0, page: 1, pageSize: 50 }) })
  expect(list).toHaveBeenCalledTimes(2)
  view.unmount()
  await act(async () => { pending[1]!({ ok: true, scope: { workspaceId: 'new', spaceEpoch: 'new' }, revision: 0, rows: [], total: 0, page: 1, pageSize: 50 }) })
  expect(list).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(/99/)).toBeNull()
})
it('连选卡片时旧详情不能覆盖新编辑页；换文献后旧来源响应不能打开原文或锁死新页', async () => {
  const first = evidenceDocument().cards[0]!, second = evidenceDocument().cards[0]!
  first.versions[0]!.quote = '旧卡'; second.versions[0]!.quote = '新卡'
  const details: ((value: unknown) => void)[] = [], sources: ((value: unknown) => void)[] = [], open = vi.fn()
  const api = {
    list: vi.fn().mockResolvedValue({ ok: true, revision: 2, rows: [{ paperId: fields().paperId, cards: [first, second].map(c => ({ ...c.versions[0], cardId: c.id, sourceStatus: 'unbound' })) }], total: 1, page: 1, pageSize: 50 }),
    detail: vi.fn(() => new Promise(resolve => details.push(resolve))),
    openSource: vi.fn(() => new Promise(resolve => sources.push(resolve)))
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { libraryEvidence: api } })
  const scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
  const view = render(<EvidencePanel paperId={fields().paperId} scope={scope} onOpenSource={open} />)
  await screen.findAllByRole('button', { name: /研究问题/ })
  fireEvent.click(screen.getAllByRole('button', { name: /研究问题/ })[0]!)
  await waitFor(() => expect(details.length).toBe(1))
  fireEvent.click(screen.getAllByRole('button', { name: /研究问题/ })[1]!)
  await waitFor(() => expect(details.length).toBe(2))
  await act(async () => { details[1]!({ ok: true, revision: 2, card: second }) })
  await act(async () => { details[0]!({ ok: true, revision: 2, card: first }) })
  expect((screen.getByLabelText('原文摘录') as HTMLTextAreaElement).value).toBe('新卡')
  fireEvent.click(screen.getByRole('button', { name: '打开原文', exact: true }))
  await waitFor(() => expect(sources.length).toBe(1))
  view.rerender(<EvidencePanel paperId="new-paper" scope={scope} onOpenSource={open} />)
  await waitFor(() => expect((screen.getByRole('button', { name: '新建证据卡' }) as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { sources[0]!({ ok: true, source: { status: 'available', pdfUrl: 'mimir-pdf://paper/old.pdf', locationMode: 'manual-page' } }) })
  expect(open).not.toHaveBeenCalled()
})
