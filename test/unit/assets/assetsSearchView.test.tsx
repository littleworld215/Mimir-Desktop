// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Assets } from '../../../src/components/modules/assets/Assets'
import type { AssetDetail } from '../../../shared/assetsContracts'

const scope = { workspaceId: 'A', spaceEpoch: 'A#1' }
const a: AssetDetail = { id: 1, code: 'a', name: 'Original', category: 'inbox', categoryPath: ['收集箱'], description: '', storageType: 'inline_text', externalUrl: null, sourceJson: '{}', sourceTask: '', notes: '', kind: null, templateConfig: { version: 1, variables: {} }, currentVersionId: 1, currentVersion: 1, currentContent: 'original', isFavorite: 0, lastUsedAt: null, archivedAt: null, revision: 1, createdAt: 'now', updatedAt: 'now', versionCount: 1, tags: [], fileAvailable: false, currentFileName: null }
const b = { ...a, id: 2, code: 'b', name: 'Target' }
let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  api = {
    context: vi.fn().mockResolvedValue({ ok: true, context: scope }),
    list: vi.fn().mockResolvedValue({ ok: true, page: { items: [a], total: 1, page: 1, pageSize: 30 } }),
    listCategories: vi.fn().mockResolvedValue({ ok: true, categories: [] }),
    listTags: vi.fn().mockResolvedValue({ ok: true, tags: [{ id: 4, name: 'Tag', color: null, revision: 1 }] }),
    get: vi.fn((request: { assetId: number }) => Promise.resolve({ ok: true, asset: request.assetId === 1 ? a : b })),
    references: vi.fn().mockResolvedValue({ ok: true, references: { assetId: 1, revision: 1, references: [], referencedBy: [b] } }),
    referenceGraph: vi.fn().mockResolvedValue({ ok: true, graph: { rootId: 1, depth: 2, nodes: [a, b], edges: [{ sourceAssetId: 2, targetAssetId: 1 }], truncated: true } }),
    addReference: vi.fn().mockResolvedValue({ ok: false, code: 'REVISION_CONFLICT', message: '资产已改变，请重新加载' })
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { assets: api } })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
async function ready() { render(<Assets />); await screen.findByRole('button', { name: /Original/ }) }
it('检索防抖，IME中不发查询，结束后应用并重置页码', async () => {
  await ready()
  vi.useFakeTimers()
  const search = screen.getByLabelText('检索资产')
  fireEvent.compositionStart(search)
  fireEvent.change(search, { target: { value: '科研' } })
  await act(async () => { vi.advanceTimersByTime(500) })
  expect(api.list).toHaveBeenCalledTimes(1)
  fireEvent.compositionEnd(search, { data: '科研' })
  await act(async () => { vi.advanceTimersByTime(350) })
  expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '科研', page: 1 }))
})
it('筛选提交组合参数并重置页码；清空取消未提交的检索', async () => {
  await ready()
  fireEvent.change(screen.getByLabelText('检索范围'), { target: { value: 'organization' } })
  fireEvent.change(screen.getByLabelText('排序方式'), { target: { value: 'name' } })
  fireEvent.change(screen.getByLabelText('条目类型'), { target: { value: 'ordinary' } })
  fireEvent.change(screen.getByLabelText('更新起始日期'), { target: { value: '2026-10-07' } })
  fireEvent.click(screen.getByLabelText('排除标签 Tag'))
  await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ searchIn: 'organization', sort: 'name', kind: null, updatedAfter: '2026-10-07', excludeTagIds: [4], page: 1 })))
  vi.useFakeTimers()
  fireEvent.change(screen.getByLabelText('检索资产'), { target: { value: 'uncommitted' } })
  fireEvent.click(screen.getByRole('button', { name: '清空筛选' }))
  await act(async () => { vi.advanceTimersByTime(400) })
  expect((screen.getByLabelText('检索资产') as HTMLInputElement).value).toBe('')
  expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: undefined, searchIn: 'all', sort: undefined, kind: undefined, excludeTagIds: [] }))
})
it('迟到旧查询不得覆盖新结果，失败可重试', async () => {
  await ready()
  let resolveOld!: (value: unknown) => void
  api.list.mockImplementation((request: { q?: string }) => request.q === 'old'
    ? new Promise(resolve => { resolveOld = resolve })
    : Promise.resolve({ ok: true, page: { items: [{ ...b, name: 'New result' }], total: 1, page: 1, pageSize: 30 } }))
  fireEvent.change(screen.getByLabelText('检索资产'), { target: { value: 'old' } })
  fireEvent.keyDown(screen.getByLabelText('检索资产'), { key: 'Enter' })
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'))
  fireEvent.change(screen.getByLabelText('检索资产'), { target: { value: 'new' } })
  fireEvent.keyDown(screen.getByLabelText('检索资产'), { key: 'Enter' })
  await screen.findByRole('button', { name: /New result/ })
  await act(async () => resolveOld({ ok: true, page: { items: [{ ...a, name: 'Old stale' }], total: 1, page: 1, pageSize: 30 } }))
  expect(screen.queryByRole('button', { name: /Old stale/ })).toBeNull()
  api.list.mockResolvedValueOnce({ ok: false, code: 'WRITE_FAILED', message: 'retry me' })
  fireEvent.change(screen.getByLabelText('排序方式'), { target: { value: 'updated' } })
  await screen.findByText('retry me')
  fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
  await waitFor(() => expect(screen.queryByText('retry me')).toBeNull())
})
it('匹配片段使用React文本，HTML不执行，UTF16区间正确高亮', async () => {
  api.list.mockResolvedValue({ ok: true, page: { items: [{ ...a, excerpt: { text: '😀<script>needle</script>', matches: [{ start: 10, end: 16 }] } }], total: 1, page: 1, pageSize: 30 } })
  await ready()
  expect(screen.getByText('needle', { selector: 'mark' }).textContent).toBe('needle')
  expect(document.querySelector('script')).toBeNull()
  expect(screen.getByRole('button', { name: /Original/ }).textContent).toContain('😀<script>needle</script>')
})
it('参见读取/反向跳转/截断关系图可操作，未读全关系明确提示', async () => {
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /Original/ }))
  fireEvent.click(await screen.findByRole('button', { name: '查看关系图' }))
  await screen.findByText(/部分关系/)
  fireEvent.click(screen.getByRole('button', { name: '打开关系资产 Target' }))
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith({ ...scope, assetId: 2 }))
})
it('关联预览失效：清空或换查询后，旧目标响应不可复活', async () => {
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /Original/ }))
  await screen.findByLabelText('查找关联资产')
  api.list.mockResolvedValue({ ok: true, page: { items: [b], total: 1, page: 1, pageSize: 10 } })
  fireEvent.change(screen.getByLabelText('查找关联资产'), { target: { value: 'Target' } })
  fireEvent.click(screen.getByRole('button', { name: '查找目标' }))
  fireEvent.click(await screen.findByRole('button', { name: '选择关联资产 Target' }))
  await screen.findByText(/已选择：Target/)
  fireEvent.change(screen.getByLabelText('查找关联资产'), { target: { value: 'Other' } })
  expect(screen.queryByText(/已选择：Target/)).toBeNull()
  expect((screen.getByRole('button', { name: '添加参见' }) as HTMLButtonElement).disabled).toBe(true)
})
it('条件失败保留选中的目标与检索输入，允许重新加载源资产后重试', async () => {
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /Original/ }))
  await screen.findByLabelText('查找关联资产')
  api.list.mockResolvedValue({ ok: true, page: { items: [b], total: 1, page: 1, pageSize: 10 } })
  fireEvent.change(screen.getByLabelText('查找关联资产'), { target: { value: 'Target' } })
  fireEvent.click(screen.getByRole('button', { name: '查找目标' }))
  fireEvent.click(await screen.findByRole('button', { name: '选择关联资产 Target' }))
  await screen.findByText(/已选择：Target/)
  fireEvent.click(screen.getByRole('button', { name: '添加参见' }))
  await screen.findByText('资产已改变，请重新加载')
  expect((screen.getByLabelText('查找关联资产') as HTMLInputElement).value).toBe('Target')
  expect(screen.getByText(/已选择：Target/)).toBeTruthy()
  api.get.mockResolvedValue({ ok: true, asset: { ...a, revision: 2 } })
  fireEvent.click(screen.getByRole('button', { name: '重新加载资产与关系' }))
  await waitFor(() => expect(api.references).toHaveBeenCalledTimes(2))
  expect(screen.getByText(/已选择：Target/)).toBeTruthy()
})

it('迟到的目标正文与查询不能恢复已失效的选择', async () => {
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /Original/ }))
  await screen.findByLabelText('查找关联资产')
  let finishLookup!: (value: unknown) => void, finishTarget!: (value: unknown) => void
  api.list.mockImplementationOnce(() => new Promise(resolve => { finishLookup = resolve }))
  fireEvent.click(screen.getByRole('button', { name: '查找目标' }))
  fireEvent.change(screen.getByLabelText('查找关联资产'), { target: { value: 'changed' } })
  await act(async () => finishLookup({ ok: true, page: { items: [b], total: 1, page: 1, pageSize: 10 } }))
  expect(screen.queryByRole('button', { name: '选择关联资产 Target' })).toBeNull()
  api.list.mockResolvedValueOnce({ ok: true, page: { items: [b], total: 1, page: 1, pageSize: 10 } })
  fireEvent.click(screen.getByRole('button', { name: '查找目标' }))
  api.get.mockImplementationOnce(() => new Promise(resolve => { finishTarget = resolve }))
  fireEvent.click(await screen.findByRole('button', { name: '选择关联资产 Target' }))
  fireEvent.change(screen.getByLabelText('查找关联资产'), { target: { value: '' } })
  await act(async () => finishTarget({ ok: true, asset: b }))
  expect(screen.queryByText(/已选择：Target/)).toBeNull()
  expect((screen.getByRole('button', { name: '添加参见' }) as HTMLButtonElement).disabled).toBe(true)
})

it('切空间卸载后，旧列表和关系图响应不能写入新空间', async () => {
  const first = render(<Assets />)
  fireEvent.click(await screen.findByRole('button', { name: /Original/ }))
  let finish!: (value: unknown) => void
  api.referenceGraph.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(await screen.findByRole('button', { name: '查看关系图' }))
  first.unmount()
  api.context.mockResolvedValue({ ok: true, context: { workspaceId: 'B', spaceEpoch: 'B#2' } })
  api.list.mockResolvedValue({ ok: true, page: { items: [{ ...b, name: 'Space B' }], total: 1, page: 1, pageSize: 30 } })
  render(<Assets />)
  await screen.findByRole('button', { name: /Space B/ })
  await act(async () => finish({ ok: true, graph: { rootId: 1, depth: 2, nodes: [a, b], edges: [], truncated: true } }))
  expect(screen.queryByText(/部分关系/)).toBeNull()
  expect(screen.queryByRole('button', { name: '打开关系资产 Target' })).toBeNull()
  expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'B', spaceEpoch: 'B#2' }))
})

it('翻到第二页后检索会回到第一页；组合输入中的Enter不提前提交', async () => {
  api.list.mockImplementation((request: { page: number }) => Promise.resolve({ ok: true, page: { items: [a], total: 60, page: request.page, pageSize: 30 } }))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })))
  const search = screen.getByLabelText('检索资产')
  fireEvent.compositionStart(search)
  fireEvent.change(search, { target: { value: '科研' } })
  fireEvent.keyDown(search, { key: 'Enter', keyCode: 229, isComposing: true })
  expect(api.list).toHaveBeenCalledTimes(2)
  fireEvent.compositionEnd(search)
  fireEvent.keyDown(search, { key: 'Enter' })
  await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: '科研', page: 1 })))
})

it('关系图箭头停在节点边界之外，并明确标记归档目标', async () => {
  api.referenceGraph.mockResolvedValue({ ok: true, graph: { rootId: 1, depth: 2, nodes: [a, { ...b, archivedAt: '2026-10-07' }], edges: [{ sourceAssetId: 1, targetAssetId: 2 }, { sourceAssetId: 2, targetAssetId: 1 }], truncated: false } })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /Original/ }))
  fireEvent.click(await screen.findByRole('button', { name: '查看关系图' }))
  await screen.findByRole('button', { name: '打开关系资产 Target（已归档）' })
  const paths = [...document.querySelectorAll('svg[aria-label="关系图"] path[marker-end]')]
  expect(paths).toHaveLength(2)
  expect(paths[0].getAttribute('d')).not.toBe(paths[1].getAttribute('d'))
  expect(paths[0].getAttribute('d')).not.toMatch(/240 45$/)
  expect(screen.getByText('Original → Target（已归档）')).toBeTruthy()
})
