import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import type { AssetDetail, AssetCategory, AssetTag } from '../../shared/assetsContracts'
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), manager: null as import('../../electron/assets/store').AssetsStoreManager | null }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler) } }))
vi.mock('../../electron/assets/store', async original => ({
  ...await original<typeof import('../../electron/assets/store')>(),
  assetsStoreManager: {
    context: () => state.manager!.context(),
    getForRequest: (scope: Parameters<import('../../electron/assets/store').AssetsStoreManager['getForRequest']>[0]) => state.manager!.getForRequest(scope),
    run: (scope: import('../../shared/assetsContracts').WorkspaceRequest, operation:(ctx:import('../../electron/assets/types').AssetsContext)=>Promise<unknown>) => state.manager!.run(scope,operation)
  }
}))
vi.mock('../../electron/logger', () => ({ default: { error: vi.fn() } }))
import { AssetsStoreManager } from '../../electron/assets/store'
import { registerAssetsHandlers } from '../../electron/ipc/assets'
import { ASSETS_CHANNELS } from '../../shared/assetsContracts'
let root: string, epoch: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'assets-full-ipc-')); epoch = 'A#1'
  state.manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
  state.handlers.clear(); registerAssetsHandlers()
})
afterEach(async () => { await state.manager!.close(); rmSync(root, { recursive: true, force: true }) })
async function call<T = Record<string, unknown>>(method: keyof typeof ASSETS_CHANNELS, input: Record<string, unknown> = {}) {
  return await state.handlers.get(ASSETS_CHANNELS[method])!({}, { workspaceId: 'A', spaceEpoch: 'A#1', ...input }) as T & { ok: boolean; code?: string }
}
async function create() {
  const result = await call<{ asset: AssetDetail }>('create', { input: { name: 'Text', category: 'inbox', storageType: 'inline_text', content: 'original' } })
  expect(result.ok).toBe(true); return result.asset
}
it('六个取用固定合同执行、未知字段拒绝、陈旧scope与筛选revision零写', async()=>{
  const a=await create()
  for(const method of ['setFavorite','recordUsage','listSavedFilters','createSavedFilter','updateSavedFilter','deleteSavedFilter'] as const) {
    expect(await call(method,{unknown:true})).toMatchObject({ok:false,code:'BAD_REQUEST'})
    expect(await call(method,{spaceEpoch:'old'})).toMatchObject({ok:false,code:'SPACE_CHANGED'})
  }
  expect(await call('setFavorite',{assetId:a.id,favorite:true})).toMatchObject({ok:true,favorite:true})
  expect(await call('recordUsage',{assetIds:[a.id]})).toMatchObject({ok:true,recordedAt:expect.any(String)})
  expect(await call('get',{assetId:a.id})).toMatchObject({asset:{revision:1,versionCount:1,isFavorite:1}})
  const f=await call<{filter:{id:number;revision:number}}>('createSavedFilter',{name:'saved',query:{view:'favorites',page:3}})
  expect(f.ok).toBe(true)
  expect(await call('updateSavedFilter',{filterId:f.filter.id,expectedRevision:2,name:'stale',query:{}})).toMatchObject({ok:false,code:'REVISION_CONFLICT'})
  expect(await call('listSavedFilters')).toMatchObject({ok:true,filters:[{name:'saved',revision:1}]})
  expect(await call('deleteSavedFilter',{filterId:f.filter.id,expectedRevision:1})).toMatchObject({ok:true,deletedId:f.filter.id})
})
it('真实创建分页详情更新版本归档恢复删除闭环，列表不再假空态', async () => {
  const a = await create()
  const list = await call<{ page: { total: number; items: AssetDetail[] } }>('list')
  expect(list.page.total).toBe(1); expect(list.page.items[0].id).toBe(a.id)
  expect(list.page.items[0]).not.toHaveProperty('currentContent')
  expect((await call('get', { assetId: a.id })).asset).toEqual(a)
  const updated = await call<{ asset: AssetDetail }>('update', { assetId: a.id, expectedRevision: a.revision, expectedCurrentVersionId: a.currentVersionId, patch: { content: 'new' } })
  expect(updated.asset).toMatchObject({ revision: 2, versionCount: 2 })
  expect(await call('archive', { assetId: a.id, expectedRevision: 2 })).toMatchObject({ ok: true, changed: true })
  expect(await call('list')).toMatchObject({ ok: true, page: { total: 0 } })
  expect(await call('listCategories', { archived: 'only' })).toMatchObject({ ok: true, categories: expect.arrayContaining([expect.objectContaining({ code: 'inbox', assetCount: 1 })]) })
  expect(await call('restore', { assetId: a.id, expectedRevision: 3 })).toMatchObject({ ok: true, changed: true })
  expect(await call('deletePreview', { assetId: a.id })).toMatchObject({ ok: true, impact: { revision: 4, versionCount: 2 } })
  expect(await call('delete', { assetId: a.id, expectedRevision: 4, confirm: true })).toEqual({ ok: true, deletedId: a.id, cleanupPending: false })
  expect(await call('get', { assetId: a.id })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
})
it('分类五通道和标签八通道实际执行且条件冲突零部分写入', async () => {
  const c = await call<{ category: AssetCategory }>('createCategory', { input: { code: 'custom', name: 'Custom' } })
  expect(c.ok).toBe(true)
  expect(await call('categoryImpact', { code: 'custom' })).toMatchObject({ ok: true })
  expect(await call('updateCategory', { code: 'custom', expectedRevision: c.category.revision, patch: { name: 'Renamed' } })).toMatchObject({ ok: true, category: { revision: 2 } })
  expect(await call('deleteCategory', { code: 'custom', expectedRevision: 2, confirm: false })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await call('deleteCategory', { code: 'custom', expectedRevision: 2, confirm: true })).toEqual({ ok: true, deletedCode: 'custom' })
  const a = await create(), t = await call<{ tag: AssetTag }>('createTag', { name: 'Rust' })
  expect(await call('addTags', { assetId: a.id, expectedRevision: 1, tags: [{ id: t.tag.id }] })).toMatchObject({ ok: true, asset: { revision: 2 } })
  expect(await call('tagImpact', { tagId: t.tag.id })).toMatchObject({ ok: true, impact: { assetCount: 1 } })
  expect(await call('renameTag', { tagId: t.tag.id, expectedRevision: 1, name: 'bad' })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
  expect(await call('renameTag', { tagId: t.tag.id, expectedRevision: 2, name: 'New' })).toMatchObject({ ok: true, tag: { revision: 3 } })
  expect(await call('update', { assetId: a.id, expectedRevision: 2, patch: { tagNames: ['Rust'] } })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
  const target = await call<{ tag: AssetTag }>('createTag', { name: 'Target' })
  expect(await call('mergeTags', { sourceId: t.tag.id, targetId: target.tag.id, expectedSourceRevision: 3, expectedTargetRevision: 1, confirm: true })).toMatchObject({ ok: true, target: { revision: 2 } })
  expect(await call('removeTags', { assetId: a.id, expectedRevision: 4, tagIds: [target.tag.id] })).toMatchObject({ ok: true, asset: { revision: 5, tags: [] } })
  expect(await call('deleteTag', { tagId: target.tag.id, expectedRevision: 3, confirm: true })).toMatchObject({ ok: true })
  expect(await call('listTags')).toMatchObject({ ok: true, tags: [] })
})
it('所有空间绑定通道都捕获失效scope；非法shape不reject', async () => {
  await create(); epoch = 'A#2'
  for (const [method, channel] of Object.entries(ASSETS_CHANNELS)) {
    if (method === 'context') continue
    // import/save validate paths before manager; missing path still returns a structured error.
    const result = await state.handlers.get(channel)!({}, { workspaceId: 'A', spaceEpoch: 'A#1' }) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    if (!['importFile', 'saveFile', 'readExchangeFile', 'saveExchange', 'scanFolder', 'listVersions', 'getVersion', 'diffVersions', 'rollbackVersion'].includes(method)) expect(result.code).toBe('SPACE_CHANGED')
    expect(await state.handlers.get(channel)!({}, [])).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  }
})
it('显式undefined版本条件拒绝，元信息与回滚均零写入', async () => {
  const a = await create()
  const condition = { assetId: a.id, expectedRevision: a.revision, expectedCurrentVersionId: undefined }
  expect(await call('update', { ...condition, patch: { name: 'changed' } })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await call('rollbackVersion', { ...condition, versionId: a.currentVersionId })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect((await call('get', { assetId: a.id })).asset).toEqual(a)
})
