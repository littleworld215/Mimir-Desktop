// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Library } from '../../../src/components/modules/library/Library'
import { readLibraryBrowseState, writeLibraryBrowseState, type LibraryBrowseSnapshot } from '../../../src/lib/libraryBrowseState'
import { registerEvidenceEditor, setEvidenceLeaveChooser } from '../../../src/lib/evidenceEditGuard'
import { useLibraryBrowseState } from '../../../src/components/modules/library/useLibraryBrowseState'

vi.mock('../../../src/components/modules/library/ProjectBar', () => ({ ProjectBar: ({ selectedProjectId, onSelect }: any) => <div><span data-testid="project">{selectedProjectId ?? 'all'}</span><button onClick={() => void onSelect('p1')}>选择课题</button></div> }))
vi.mock('../../../src/components/modules/library/SearchPanel', () => ({ SearchPanel: () => null }))
vi.mock('../../../src/components/modules/library/SubscriptionsBar', () => ({ SubscriptionsBar: () => null }))
vi.mock('../../../src/components/modules/library/PaperCard', () => ({ PaperCard: ({ paper, onDownloadPdf }: any) => <><h3>{paper.title}</h3><button>阅读 {paper.title}</button><button onClick={() => void onDownloadPdf(paper.arxivId)}>刷新 {paper.title}</button></> }))
vi.mock('../../../src/components/modules/library/evidence/EvidenceMatrix', () => ({ EvidenceMatrix: ({ initialBrowseState }: any) => <div data-testid="matrix-filter">{initialBrowseState?.filter?.keyword ?? 'none'}</div> }))

const paper = { arxivId: 'same-paper', title: 'Fairness', authors: [], summary: '', notes: '', tags: [], projectIds: ['p1'], addedAt: '2026-10-30', url: 'https://example.org/synthetic' }
const search = () => screen.getByRole('searchbox', { name: '库内检索' }) as HTMLInputElement
function state(patch: Partial<LibraryBrowseSnapshot> = {}): LibraryBrowseSnapshot {
  return { version: 1, projectId: 'p1', view: 'papers', keyword: 'fairness', scrollTop: 0, readers: [], ...patch }
}
function api(space = 'A', projects: Promise<unknown> = Promise.resolve({ ok: true, projects: [{ id: 'p1', title: '课题一' }] })) {
  const library = {
    listProjects: vi.fn().mockReturnValue(projects),
    listPapers: vi.fn().mockResolvedValue({ ok: true, scope: { workspaceId: space, spaceEpoch: space + '#1' }, papers: [paper, { ...paper, arxivId: 'other', title: 'Ocean', projectIds: [] }] }),
    listSubscriptions: vi.fn().mockResolvedValue({ ok: true, subscriptions: [] }),
    fetchPaperPdf: vi.fn().mockResolvedValue({ ok: true })
  }
  window.electronAPI = { library } as never
  return library
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

it('模块往返恢复项目和关键词，同ID第二空间不复用旧位置', async () => {
  writeLibraryBrowseState(localStorage, 'A', state())
  api(); const view = render(<Library />)
  await waitFor(() => expect(search().value).toBe('fairness'))
  expect(screen.getByTestId('project').textContent).toBe('p1')
  fireEvent.change(screen.getByRole('searchbox', { name: '库内检索' }), { target: { value: 'Ocean' } })
  await waitFor(() => expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('Ocean'))
  view.unmount(); api(); const reopened = render(<Library />)
  await waitFor(() => expect(search().value).toBe('Ocean'))
  reopened.unmount(); api('B'); render(<Library />)
  await screen.findByRole('heading', { name: 'Fairness' })
  expect(search().value).toBe('')
  expect(readLibraryBrowseState(localStorage, 'B').state).toBeUndefined()
})

it('迟到的项目加载不能覆盖用户新输入，并保存新选择而非旧快照', async () => {
  writeLibraryBrowseState(localStorage, 'A', state({ keyword: 'old filter' }))
  let release!: (value: unknown) => void
  api('A', new Promise(resolve => { release = resolve }))
  render(<Library />)
  fireEvent.change(screen.getByRole('searchbox', { name: '库内检索' }), { target: { value: 'new intent' } })
  await act(async () => { release({ ok: true, projects: [{ id: 'p1', title: '课题一' }] }) })
  await waitFor(() => expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('new intent'))
  expect(search().value).toBe('new intent')
})

it('失效项目明确提示，不恢复已回收对象；可清除本空间偏好', async () => {
  writeLibraryBrowseState(localStorage, 'A', state({ projectId: 'deleted', keyword: '', returnPaperId: 'trashed' }))
  writeLibraryBrowseState(localStorage, 'B', state())
  api(); render(<Library />)
  await screen.findByText(/上次项目已失效/)
  expect(screen.getByTestId('project').textContent).toBe('all')
  fireEvent.click(screen.getByRole('button', { name: '清除本空间浏览位置' }))
  await waitFor(() => expect(readLibraryBrowseState(localStorage, 'A').state).toBeUndefined())
  expect(readLibraryBrowseState(localStorage, 'B').state?.projectId).toBe('p1')
})

it('恢复矩阵原筛选，返回列表后仍保留原库内检索', async () => {
  writeLibraryBrowseState(localStorage, 'A', state({ view: 'matrix', matrix: { filter: { archive: 'include', source: 'all', keyword: '条件' }, page: 1, scrollTop: 0 } }))
  api(); render(<Library />)
  await waitFor(() => expect(screen.getByTestId('matrix-filter').textContent).toBe('条件'))
  fireEvent.click(screen.getByRole('button', { name: '返回文献列表', exact: true }))
  await waitFor(() => expect(search().value).toBe('fairness'))
})

it('保存失败阻止自动恢复，也保留正在编辑的外部输入', async () => {
  writeLibraryBrowseState(localStorage, 'A', state())
  const save = vi.fn().mockResolvedValue(false)
  const remove = registerEvidenceEditor({ isDirty: () => true, isBusy: () => false, save, discard() {} })
  const chooser = setEvidenceLeaveChooser(async () => 'save')
  try {
    api(); render(<Library />)
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(search().value).toBe('')
    expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('fairness')
  } finally { remove(); chooser() }
})

it('恢复合法文献焦点；回收或筛选不可见条目不抢焦点', async () => {
  writeLibraryBrowseState(localStorage, 'A', state({ returnPaperId: 'same-paper' }))
  api(); const view = render(<Library />)
  await waitFor(() => expect(search().value).toBe('fairness'))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '阅读 Fairness' })))
  view.unmount()
  writeLibraryBrowseState(localStorage, 'A', state({ projectId: null, returnPaperId: 'other' }))
  api(); render(<Library />)
  await waitFor(() => expect(search().value).toBe('fairness'))
  const hiddenRow = document.querySelector<HTMLElement>('[data-library-paper-id="other"]')!
  expect(hiddenRow.hidden).toBe(true)
  expect(document.activeElement).not.toBe(hiddenRow.querySelector('button'))
})

it('旧scope/代际回调和卸载后回调不能写入本机偏好', async () => {
  writeLibraryBrowseState(localStorage, 'A', state())
  const hook = renderHook(({ scope }) => useLibraryBrowseState(scope), { initialProps: { scope: { workspaceId: 'A', spaceEpoch: '1' } } })
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  const oldPersist = hook.result.current.persist
  hook.rerender({ scope: { workspaceId: 'A', spaceEpoch: '2' } })
  await act(async () => { oldPersist(state({ keyword: 'stale' })) })
  expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('fairness')
  hook.rerender({ scope: { workspaceId: 'B', spaceEpoch: '1' } })
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  const afterUnmount = hook.result.current.persist
  hook.unmount(); afterUnmount(state())
  expect(readLibraryBrowseState(localStorage, 'B').state).toBeUndefined()
})

it('同一宿主刷新收到新scope时不把旧筛选写进另一空间', async () => {
  writeLibraryBrowseState(localStorage, 'B', state({ projectId: null, keyword: 'Ocean' }))
  const library = api(); render(<Library />)
  await screen.findByRole('heading', { name: 'Fairness' })
  fireEvent.change(search(), { target: { value: 'Fairness' } })
  await waitFor(() => expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('Fairness'))
  library.listPapers.mockResolvedValue({ ok: true, scope: { workspaceId: 'B', spaceEpoch: 'B#1' }, papers: [paper, { ...paper, arxivId: 'other', title: 'Ocean', projectIds: [] }] })
  fireEvent.click(screen.getByRole('button', { name: '刷新 Fairness' }))
  await waitFor(() => expect(search().value).toBe('Ocean'))
  expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('Fairness')
  expect(readLibraryBrowseState(localStorage, 'B').state?.keyword).toBe('Ocean')
})

it('新scope刷新遇到脏输入时保留原编辑与两空间偏好，不混入新数据', async () => {
  writeLibraryBrowseState(localStorage, 'B', state({ projectId: null, keyword: 'Ocean' }))
  const library = api(); render(<Library />)
  await screen.findByRole('heading', { name: 'Fairness' })
  fireEvent.change(search(), { target: { value: 'Fairness' } })
  await waitFor(() => expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('Fairness'))
  const remove = registerEvidenceEditor({ isDirty: () => true, isBusy: () => false, save: async () => false, discard() {} })
  try {
    library.listPapers.mockResolvedValue({ ok: true, scope: { workspaceId: 'B', spaceEpoch: 'B#1' }, papers: [] })
    fireEvent.click(screen.getByRole('button', { name: '刷新 Fairness' }))
    await screen.findByText(/科研空间已变化，当前输入保留/)
    expect(search().value).toBe('Fairness')
    expect(readLibraryBrowseState(localStorage, 'A').state?.keyword).toBe('Fairness')
    expect(readLibraryBrowseState(localStorage, 'B').state?.keyword).toBe('Ocean')
  } finally { remove() }
})
