// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { usePaperRecoveryDraft } from '../../src/components/modules/library/usePaperRecoveryDraft'
import { PaperDraftRecovery } from '../../src/components/modules/library/PaperDraftRecovery'
import { PaperCard } from '../../src/components/modules/library/PaperCard'
import { requestEvidenceLeave } from '../../src/lib/evidenceEditGuard'
import type { EditingDraft } from '../../shared/libraryEditingContracts'
const scope = { workspaceId: 's', spaceEpoch: '1' }
const paper = { arxivId: 'p', title: 'synthetic', notes: 'base', tags: ['old'], summary: '', authors: [], url: '', projectIds: [], addedAt: '' }
const row = (input = 'raw'): EditingDraft => ({ id: 'draft', paperId: 'p', kind: 'notes', base: { notes: 'base' }, input, revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' })
function bridge() {
  let revision = 0
  const api = {
    open: vi.fn(async () => ({ ok: true, base: { notes: 'base' }, existing: [], sessionId: 'session', revision: 0 })),
    saveDraft: vi.fn(async (r: any) => ({ ok: true, draft: { ...row(r.write.input), revision: ++revision } })),
    detail: vi.fn(async () => ({ ok: true, draft: row(), status: 'editable' })),
    close: vi.fn(async () => ({ ok: true })), discard: vi.fn(async () => ({ ok: true })),
    commit: vi.fn(async () => ({ ok: true, paper: { ...paper, notes: 'new', tags: ['new'] }, state: 'saved', cleanup: 'done' })),
    saveWithoutRecovery: vi.fn(async () => ({ ok: true, paper: { ...paper, notes: 'legacy' } }))
  }
  window.electronAPI = { libraryEditing: api } as never
  return api
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
it('499ms sends nothing, 500ms saves exact whitespace but never commits formal data', async () => {
  vi.useFakeTimers(); const api = bridge()
  const { rerender } = renderHook(({ input }) => usePaperRecoveryDraft({ scope, paperId: 'p', kind: 'notes', base: { notes: 'base' }, input, onRestore: vi.fn() }), { initialProps: { input: 'base' } })
  await flush(); rerender({ input: '\n  new \n' })
  await act(() => vi.advanceTimersByTimeAsync(499)); expect(api.saveDraft).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(1)); expect(api.saveDraft).toHaveBeenCalledOnce()
  expect(api.saveDraft.mock.calls[0][0].write.input).toBe('\n  new \n'); expect(api.commit).not.toHaveBeenCalled()
})
it('in-flight autosave serializes and coalesces unsent edits to the latest input', async () => {
  vi.useFakeTimers(); const api = bridge(); let finish!: (r: any) => void
  api.saveDraft.mockImplementationOnce(() => new Promise(r => { finish = r }))
  const { result, rerender } = renderHook(({ input }) => usePaperRecoveryDraft({ scope, paperId: 'p', kind: 'notes', base: { notes: 'base' }, input, onRestore: vi.fn() }), { initialProps: { input: 'base' } })
  await flush(); rerender({ input: 'first' }); await act(() => vi.advanceTimersByTimeAsync(500))
  rerender({ input: 'middle' }); rerender({ input: 'latest' }); await act(() => vi.advanceTimersByTimeAsync(500))
  expect(api.saveDraft).toHaveBeenCalledOnce()
  await act(async () => { finish({ ok: true, draft: row('first') }) }); await flush()
  expect(api.saveDraft).toHaveBeenCalledTimes(2); expect(api.saveDraft.mock.calls[1][0].write.input).toBe('latest')
  expect(result.current.status).toBe('saved')
})
it('an existing recovery choice blocks autosave and formal save until explicit resume or discard', async () => {
  vi.useFakeTimers(); const api = bridge(); api.open.mockResolvedValue({ ok: true, base: { notes: 'base' }, existing: [{ ...row(), status: 'editable' }], revision: 0 } as never)
  const restore = vi.fn(), { result, rerender } = renderHook(({ input }) => usePaperRecoveryDraft({ scope, paperId: 'p', kind: 'notes', base: { notes: 'base' }, input, onRestore: restore }), { initialProps: { input: 'base' } })
  await flush(); rerender({ input: 'new typing' }); await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(api.saveDraft).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
  await expect(result.current.save()).rejects.toThrow(); expect(api.commit).not.toHaveBeenCalled()
})
it.each(['', '\n   \n'])('explicit resume restores input verbatim: %j', async input => {
  const api = bridge(), d = row(input), restore = vi.fn()
  api.open.mockResolvedValueOnce({ ok: true, base: d.base, existing: [{ ...d, status: 'editable' }], revision: 0 } as never)
  const { result } = renderHook(() => usePaperRecoveryDraft({ scope, paperId: 'p', kind: 'notes', base: { notes: 'base' }, input: 'base', onRestore: restore }))
  await flush(); await act(async () => { await result.current.restore(d) })
  expect(restore).toHaveBeenCalledWith(input); expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({ resume: { draftId: d.id, revision: d.revision } }))
})
it('a late open after unmount closes its token and never restores or writes', async () => {
  const api = bridge(); let finish!: (r: any) => void; api.open.mockImplementationOnce(() => new Promise(r => { finish = r }))
  const restore = vi.fn(), { unmount } = renderHook(() => usePaperRecoveryDraft({ scope, paperId: 'p', kind: 'append', base: { notes: 'base' }, input: 'pending', onRestore: restore }))
  unmount(); await act(async () => { finish({ ok: true, base: { notes: 'base' }, sessionId: 'late', existing: [], revision: 0 }) })
  expect(api.close).toHaveBeenCalledWith({ scope, sessionId: 'late' }); expect(restore).not.toHaveBeenCalled(); expect(api.saveDraft).not.toHaveBeenCalled()
})
it('a changed space ignores the old response and keeps the current scope', async () => {
  const api = bridge(); let finish!: (r: any) => void; api.open.mockImplementationOnce(() => new Promise(r => { finish = r }))
  const { result, rerender } = renderHook(({ epoch }) => usePaperRecoveryDraft({ scope: { ...scope, spaceEpoch: epoch }, paperId: 'p', kind: 'notes', base: { notes: 'base' }, input: 'base', onRestore: vi.fn() }), { initialProps: { epoch: '1' } })
  rerender({ epoch: '2' }); await flush(); await act(async () => { finish({ ok: true, base: {}, existing: [{ ...row(), status: 'conflict' }], revision: 0 }) })
  expect(result.current.existing).toEqual([])
})
it('conflict comparison shows complete baseline, current text and recovered input, with no force restore', async () => {
  bridge(); render(<PaperDraftRecovery draft={row('\n recovered \n')} status="conflict" current={{ notes: 'current' }} onRestore={vi.fn()} onDiscard={vi.fn()} />)
  expect(screen.getByLabelText('原始基线').textContent).toContain('base')
  expect(screen.getByLabelText('当前文献').textContent).toContain('current')
  expect(screen.getByLabelText('恢复草稿输入').textContent).toBe('\n recovered \n')
  expect(screen.queryByRole('button', { name: '恢复到编辑器' })).toBeNull()
})
const props = { paper, projects: [], selectedProjectId: null, scope, onConfirmedPaper: vi.fn(), onUpdate: vi.fn(), onRemove: vi.fn(), onDownloadPdf: vi.fn(), onOpenPdf: vi.fn(), onOpenExternal: vi.fn(), onScoreRelevance: vi.fn(), onExportBib: vi.fn() }
function cardEdit() { fireEvent.click(screen.getByRole('heading')); const card = screen.getByRole('heading').closest('div.group')! as HTMLElement; fireEvent.click(within(card).getAllByRole('button', { name: '编辑', exact: true }).at(-1)!); fireEvent.change(screen.getByPlaceholderText('写下你的阅读笔记...'), { target: { value: 'new' } }); return card }
it('failed asynchronous discard blocks leaving and preserves current input', async () => {
  vi.useFakeTimers(); const api = bridge(); render(<PaperCard {...props} />); cardEdit(); await flush(); await act(() => vi.advanceTimersByTimeAsync(500))
  api.discard.mockResolvedValueOnce({ ok: false, code: 'WRITE_FAILED', message: 'disk' } as never)
  let left = true; await act(async () => { left = await requestEvidenceLeave('discard') })
  expect(left).toBe(false); expect(screen.getByDisplayValue('new')).toBeTruthy()
})
it('combined card save commits notes and tags once and keeps successful cleanup warning visible', async () => {
  const api = bridge(); api.commit.mockResolvedValueOnce({ ok: true, paper: { ...paper, notes: 'new', tags: ['new'] }, state: 'saved', cleanup: 'pending', warning: '文献已保存，草稿清理失败' } as never)
  render(<PaperCard {...props} />); const card = cardEdit(); fireEvent.click(within(card).getAllByRole('button', { name: '编辑', exact: true })[0]); fireEvent.change(screen.getByPlaceholderText('逗号分隔，如 survey, llm'), { target: { value: 'new' } }); await flush()
  let left = false; await act(async () => { left = await requestEvidenceLeave('save') })
  expect(left).toBe(true); expect(api.commit).toHaveBeenCalledOnce(); expect(api.commit.mock.calls[0][0].writes).toHaveLength(2)
  expect(props.onUpdate).not.toHaveBeenCalled(); expect(screen.getByText('文献已保存，草稿清理失败')).toBeTruthy()
})
it('failed staging requires an explicit fallback click and combines both formal fields once', async () => {
  const api = bridge(); api.saveDraft.mockResolvedValue({ ok: false, code: 'WRITE_FAILED', message: 'disk' } as never)
  render(<PaperCard {...props} />); const card = cardEdit(); fireEvent.click(within(card).getAllByRole('button', { name: '编辑', exact: true })[0]); fireEvent.change(screen.getByPlaceholderText('逗号分隔，如 survey, llm'), { target: { value: 'new' } }); await flush()
  await act(async () => { await requestEvidenceLeave('save') }); expect(api.saveWithoutRecovery).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: '不使用恢复保护保存当前修改' })); await waitFor(() => expect(api.saveWithoutRecovery).toHaveBeenCalledOnce())
  expect(api.saveWithoutRecovery.mock.calls[0][0]).toMatchObject({ fields: { notes: 'new', tags: ['new'] } })
})
it('late formal commit after space change must not apply old paper or close the new editor', async () => {
  const api = bridge(); let finish!: (r: any) => void; api.commit.mockImplementationOnce(() => new Promise(r => { finish = r }))
  const confirmed = vi.fn(), { rerender } = render(<PaperCard {...props} onConfirmedPaper={confirmed} />); const card = cardEdit(); await flush()
  fireEvent.click(within(card).getByRole('button', { name: '保存', exact: true })); await waitFor(() => expect(api.commit).toHaveBeenCalledOnce())
  rerender(<PaperCard {...props} scope={{ ...scope, spaceEpoch: '2' }} onConfirmedPaper={confirmed} />); await flush()
  await act(async () => { finish({ ok: true, paper: { ...paper, notes: 'old-space' }, state: 'saved', cleanup: 'done' }) })
  expect(confirmed).not.toHaveBeenCalled(); expect(screen.getByPlaceholderText('写下你的阅读笔记...')).toBeTruthy()
})
it('space change does not autosave the previous page input into the new space', async () => {
  vi.useFakeTimers(); const api = bridge()
  const { rerender } = renderHook(({ epoch, input }) => usePaperRecoveryDraft({ scope: { ...scope, spaceEpoch: epoch }, paperId: 'p', kind: 'notes', base: { notes: 'base' }, input, onRestore: vi.fn() }), { initialProps: { epoch: '1', input: 'base' } })
  await flush(); rerender({ epoch: '1', input: 'old page pending' }); rerender({ epoch: '2', input: 'old page pending' }); await flush()
  await act(() => vi.advanceTimersByTimeAsync(600)); expect(api.saveDraft).not.toHaveBeenCalled()
})
it('discard waits in-flight save, then discards its confirmed revision without a later revival', async () => {
  vi.useFakeTimers(); const api = bridge(); let finish!: (r: any) => void
  api.saveDraft.mockImplementationOnce(() => new Promise(r => { finish = r }))
  const { result, rerender } = renderHook(({ input }) => usePaperRecoveryDraft({ scope, paperId: 'p', kind: 'notes', base: { notes: 'base' }, input, onRestore: vi.fn() }), { initialProps: { input: 'base' } })
  await flush(); rerender({ input: 'new' }); await act(() => vi.advanceTimersByTimeAsync(500))
  let done = false, discard!: Promise<void>; act(() => { discard = result.current.discard().then(() => { done = true }) })
  expect(done).toBe(false); expect(api.discard).not.toHaveBeenCalled()
  await act(async () => { finish({ ok: true, draft: { ...row('new'), revision: 7 } }); await discard })
  expect(api.discard).toHaveBeenCalledWith({ scope, id: 'draft', revision: 7 }); await act(() => vi.advanceTimersByTimeAsync(1000)); expect(api.saveDraft).toHaveBeenCalledOnce()
})
