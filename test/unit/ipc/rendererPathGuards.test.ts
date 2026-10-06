import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssetsStoreManager, assetsStoreManager } from '../../../electron/assets/store'
import { createAsset, getAsset } from '../../../electron/assets/assetService'
import { registerAssetsHandlers } from '../../../electron/ipc/assets'
import { assertRendererPath, assertRendererFilePath, claimAssetSavePath, pickedPaths, registerOneShotFileAuth, clearOneShotFileAuths, authorizeSaveDialog } from '../../../electron/ipc/rendererPathGuards'
import { createTestWorkspace, switchWorkspaceTo, getActiveWorkspace, currentSpaceEpoch } from '../../stubs/store'
import * as workspaceStore from '../../stubs/store'

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn) } }))
vi.mock('../../../electron/logger', () => ({ default: { error: vi.fn() } }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))
let root: string
let external: string
let manager: AssetsStoreManager
let assetId: number
let scope: { workspaceId: string; spaceEpoch: string }
let workspace: ReturnType<typeof createTestWorkspace>
beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'assets-handler-'))
  external = join(root, 'external')
  fs.mkdirSync(external)
  const path = join(root, 'workspace')
  fs.mkdirSync(path)
  workspace = createTestWorkspace('A', path)
  switchWorkspaceTo(workspace.id)
  scope = { workspaceId: workspace.id, spaceEpoch: currentSpaceEpoch() }
  manager = new AssetsStoreManager({ active: getActiveWorkspace, epoch: currentSpaceEpoch }, (p, o) => new Database(p, o))
  const ctx = await manager.getForRequest(scope)
  assetId = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'export body' }).id
  vi.spyOn(assetsStoreManager, 'run').mockImplementation((request, operation) => manager.run(request, operation))
  clearOneShotFileAuths()
  pickedPaths.clear()
  state.handlers.clear()
  registerAssetsHandlers()
})
afterEach(async () => {
  vi.restoreAllMocks()
  clearOneShotFileAuths()
  pickedPaths.clear()
  await manager.close()
  fs.rmSync(root, { recursive: true, force: true })
})
async function save(path: unknown, requestScope = scope): Promise<unknown> {
  return state.handlers.get('assets:saveFile')!({}, { ...requestScope, assetId, destinationPath: path })
}
async function importSource(path: unknown, id: number): Promise<unknown> {
  return state.handlers.get('assets:importFile')!({}, { ...scope, assetId: id, expectedRevision: 1, sourcePath: path })
}

it('真实保存 handler 使用外部精确授权并实际落盘，重复使用拒绝', async () => {
  const path = join(external, 'saved.txt')
  await authorizeSaveDialog(async () => ({ canceled: false, filePath: path }))
  expect(await save(path)).toEqual({ ok: true, saved: true })
  expect(fs.readFileSync(path, 'utf8')).toBe('export body')
  fs.unlinkSync(path)
  expect(await save(path)).toMatchObject({ ok: false, code: 'PATH_REJECTED' })
  expect(fs.existsSync(path)).toBe(false)
})
it('并发保存在首个 await 前原子消费，一次成功一次 PATH_REJECTED', async () => {
  const path = join(external, 'concurrent.txt')
  registerOneShotFileAuth(path)
  const results = await Promise.all([save(path), save(path)])
  expect(results).toContainEqual({ ok: true, saved: true })
  expect(results).toContainEqual(expect.objectContaining({ ok: false, code: 'PATH_REJECTED' }))
})
it('取消不登记新授权，正常空间内部保存无需授权', async () => {
  const path = join(external, 'cancel.txt')
  await authorizeSaveDialog(async () => ({ canceled: true, filePath: path }))
  expect(await save(path)).toMatchObject({ code: 'PATH_REJECTED' })
  expect(await save(join(workspace.path, 'inside.txt'))).toEqual({ ok: true, saved: true })
})
it('相邻与父路径不授权，picked 目录不能绕过资产导出授权', async () => {
  const path = join(external, 'picked.txt')
  registerOneShotFileAuth(path)
  pickedPaths.add(external)
  expect(await save(join(external, 'sibling.txt'))).toMatchObject({ code: 'PATH_REJECTED' })
  expect(await save(external)).toMatchObject({ code: 'PATH_REJECTED' })
  expect(await save(path)).toEqual({ ok: true, saved: true })
})
it('保存授权不授予通用读写或文件读取能力', () => {
  const path = join(external, 'isolated.txt')
  registerOneShotFileAuth(path)
  expect(() => assertRendererPath(path, 'read')).toThrow()
  expect(() => assertRendererPath(path, 'write')).toThrow()
  expect(() => assertRendererFilePath(path, 'read')).toThrow()
  expect(() => assertRendererFilePath(path, 'write')).toThrow()
  expect(claimAssetSavePath(path).path).toBe(resolve(path))
})
it('控制平面与托管目录拒绝优先，精确授权及 picked 都不可绕过', async () => {
  for (const path of [join(homedir(), '.mimir', 'forbidden.txt'), join(workspace.path, '.mimir', 'assets', 'files', 'forbidden.txt')]) {
    registerOneShotFileAuth(path)
    pickedPaths.add(path)
    expect(await save(path)).toMatchObject({ ok: false, code: 'PATH_REJECTED' })
    expect(fs.existsSync(path)).toBe(false)
  }
})
it('A→B→A 后旧授权不可复活，即便 renderer 使用新 scope', async () => {
  const path = join(external, 'stale.txt')
  registerOneShotFileAuth(path)
  const bPath = join(root, 'B')
  fs.mkdirSync(bPath)
  const b = createTestWorkspace('B', bPath)
  switchWorkspaceTo(b.id)
  switchWorkspaceTo(workspace.id)
  const newScope = { workspaceId: workspace.id, spaceEpoch: currentSpaceEpoch() }
  expect(await save(path, newScope)).toMatchObject({ code: 'PATH_REJECTED' })
})
it('对话框 await 期间空间变化不把旧选择登记到新 scope', async () => {
  const path = join(external, 'dialog-stale.txt')
  await authorizeSaveDialog(async () => {
    switchWorkspaceTo(workspace.id)
    return { canceled: false, filePath: path }
  })
  expect(await save(path, { workspaceId: workspace.id, spaceEpoch: currentSpaceEpoch() })).toMatchObject({ code: 'PATH_REJECTED' })
})
it('业务失败且未创建目标释放 lease，同 scope 可重试', async () => {
  const path = join(external, 'business-fail.txt')
  registerOneShotFileAuth(path)
  const oldId = assetId
  assetId = 999
  expect(await save(path)).toMatchObject({ code: 'NOT_FOUND' })
  assetId = oldId
  expect(await save(path)).toEqual({ ok: true, saved: true })
})
it('预占期间取消对话框后失败释放不能复活旧授权', async () => {
  const path = join(external, 'cancel-in-flight.txt')
  registerOneShotFileAuth(path)
  vi.spyOn(assetsStoreManager, 'run').mockImplementation(async () => {
    await authorizeSaveDialog(async () => ({ canceled: true }))
    throw new Error('保存前失败')
  })
  expect(await save(path)).toMatchObject({ ok: false, code: 'WRITE_FAILED' })
  vi.spyOn(assetsStoreManager, 'run').mockImplementation((request, operation) => manager.run(request, operation))
  expect(await save(path)).toMatchObject({ code: 'PATH_REJECTED' })
})
it('无可信空间仍展示原生保存对话框并返回原结果，不登记授权', async () => {
  const result = { canceled: false, filePath: join(external, 'no-scope.txt') }
  const active = vi.spyOn(workspaceStore, 'getActiveWorkspace').mockImplementation(() => { throw new Error('无空间') })
  const show = vi.fn(async () => result)
  expect(await authorizeSaveDialog(show)).toBe(result)
  expect(show).toHaveBeenCalledOnce()
  active.mockRestore()
  expect(await save(result.filePath)).toMatchObject({ code: 'PATH_REJECTED' })
})
it('原生保存成功后空间消失返回原结果，不登记授权', async () => {
  const result = { canceled: false, filePath: join(external, 'lost-scope.txt') }
  expect(await authorizeSaveDialog(async () => {
    vi.spyOn(workspaceStore, 'getActiveWorkspace').mockImplementation(() => { throw new Error('空间消失') })
    return result
  })).toBe(result)
  vi.restoreAllMocks()
  vi.spyOn(assetsStoreManager, 'run').mockImplementation((request, operation) => manager.run(request, operation))
  expect(await save(result.filePath)).toMatchObject({ code: 'PATH_REJECTED' })
})

it('实际保存成功后响应 SPACE_CHANGED 已消费授权，不被 finally 复活', async () => {
  const path = join(external, 'response-fault.txt')
  registerOneShotFileAuth(path)
  vi.spyOn(assetsStoreManager, 'run').mockImplementation((request, operation) => manager.run(request, async ctx => {
    const result = await operation(ctx)
    switchWorkspaceTo(workspace.id)
    return result
  }))
  expect(await save(path)).toMatchObject({ code: 'SPACE_CHANGED' })
  expect(fs.readFileSync(path, 'utf8')).toBe('export body')
  fs.unlinkSync(path)
  vi.spyOn(assetsStoreManager, 'run').mockImplementation((request, operation) => manager.run(request, operation))
  expect(await save(path, { workspaceId: workspace.id, spaceEpoch: currentSpaceEpoch() })).toMatchObject({ code: 'PATH_REJECTED' })
})
it('已有目标故障不释放授权供复用，即便之后删除目标', async () => {
  const path = join(external, 'existing.txt')
  fs.writeFileSync(path, 'preserve')
  registerOneShotFileAuth(path)
  expect(await save(path)).toMatchObject({ code: 'FILE_EXISTS' })
  expect(fs.readFileSync(path, 'utf8')).toBe('preserve')
  fs.unlinkSync(path)
  expect(await save(path)).toMatchObject({ code: 'PATH_REJECTED' })
})

it('非法路径参数 BAD_REQUEST，文件守卫拒绝异常 PATH_REJECTED', async () => {
  expect(await save(null)).toMatchObject({ code: 'BAD_REQUEST' })
  expect(await importSource(null, assetId)).toMatchObject({ code: 'BAD_REQUEST' })
  expect(await importSource(join(external, 'not-picked'), assetId)).toMatchObject({ code: 'PATH_REJECTED' })
})
it('真实导入 handler 接实际 SQLite：精确选择通过，目录子路径不能代替文件选择', async () => {
  const ctx = await manager.getForRequest(scope)
  const file = createAsset(ctx, { name: 'F', category: 'inbox', storageType: 'file' })
  const source = join(external, 'source.bin')
  fs.writeFileSync(source, 'actual blob')
  pickedPaths.add(external)
  expect(await importSource(source, file.id)).toMatchObject({ code: 'PATH_REJECTED' })
  pickedPaths.add(source)
  expect(await importSource(source, file.id)).toMatchObject({ ok: true, asset: { versionCount: 1, fileAvailable: true } })
  expect(getAsset(ctx, file.id).versionCount).toBe(1)
})
it('真实导入 handler 的 source symlink 拒绝分支零写入，无平台 skip', async () => {
  const ctx = await manager.getForRequest(scope)
  const file = createAsset(ctx, { name: 'F', category: 'inbox', storageType: 'file' })
  const source = join(external, 'symlink-source')
  fs.writeFileSync(source, 'source')
  pickedPaths.add(source)
  const original = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
    const stat = original(path)
    return String(path) === source ? new Proxy(stat, { get: (target, key) => key === 'isSymbolicLink' ? () => true : Reflect.get(target, key) }) : stat
  }) as typeof fs.lstatSync)
  expect(await importSource(source, file.id)).toMatchObject({ ok: false, code: 'FILE_UNAVAILABLE' })
  expect(getAsset(ctx, file.id).versionCount).toBe(0)
})
