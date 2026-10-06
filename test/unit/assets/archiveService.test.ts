import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset, listAssets } from '../../../electron/assets/assetService'
import { archiveAsset, restoreAsset, deletePreview, deleteAsset } from '../../../electron/assets/archiveService'
import { importFile, rollbackVersion, getVersion } from '../../../electron/assets/fileService'
import { listTags } from '../../../electron/assets/tagService'
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))
let root: string, manager: AssetsStoreManager, ctx: AssetsContext, epoch: string
beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'assets-archive-'))
  epoch = 'A#1'
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { vi.restoreAllMocks(); await manager.close(); fs.rmSync(root, { recursive: true, force: true }) })
const asset = () => createAsset(ctx, { name: 'Text', category: 'inbox', storageType: 'inline_text', content: 'original', tagNames: ['Rust'] })
const blob = (a: { id: number; currentVersionId: number | null }) => join(ctx.layout.root, getVersion(ctx, a.id, a.currentVersionId!).version.filePath!)
async function file() {
  const a = createAsset(ctx, { name: 'File', category: 'inbox', storageType: 'file' })
  const source = join(root, 'source.bin'); fs.writeFileSync(source, 'blob')
  return importFile(ctx, a.id, { expectedRevision: 1, expectedCurrentVersionId: null }, source)
}
it('归档恢复幂等；版本标签正文保持，列表准确', () => {
  const a = asset(), b = archiveAsset(ctx, a.id, 1)
  expect(b).toMatchObject({ changed: true, asset: { revision: 2, versionCount: 1, currentContent: 'original', tags: a.tags } })
  expect(archiveAsset(ctx, a.id, 2)).toEqual({ asset: b.asset, changed: false })
  expect(listAssets(ctx).total).toBe(0)
  expect(listAssets(ctx, { archived: 'only' }).total).toBe(1)
  const c = restoreAsset(ctx, a.id, 2)
  expect(c.asset).toMatchObject({ revision: 3, archivedAt: null })
  expect(restoreAsset(ctx, a.id, 3)).toEqual({ asset: c.asset, changed: false })
  expect(listAssets(ctx).total).toBe(1)
})
it('陈旧及非法条件、未确认删除零写入', () => {
  const a = asset()
  for (const operation of [archiveAsset, restoreAsset]) {
    expect(() => operation(ctx, a.id, 999)).toThrow()
    expect(() => operation(ctx, true, 1)).toThrow()
  }
  expect(() => deleteAsset(ctx, a.id, 1, false)).toThrow()
  expect(() => deleteAsset(ctx, a.id, 9, true)).toThrow()
  expect(getAsset(ctx, a.id)).toEqual(a)
})
it('预览包含归档与revision；删除正文版本关系，保留标签且治理条件失效', () => {
  const a = asset(), oldTag = listTags(ctx)[0]
  archiveAsset(ctx, a.id, 1)
  expect(deletePreview(ctx, a.id)).toEqual({ assetId: a.id, name: 'Text', storageType: 'inline_text', archived: true, versionCount: 1, fileCount: 0, fileBytes: 0, revision: 2 })
  expect(deleteAsset(ctx, a.id, 2, true)).toEqual({ deletedId: a.id, cleanupPending: false })
  expect(() => getAsset(ctx, a.id)).toThrow()
  expect(listTags(ctx)[0].revision).toBeGreaterThan(oldTag.revision)
  expect(ctx.write(s => s.get<{ n: number }>('SELECT COUNT(*) n FROM asset_version WHERE asset_id=?', a.id))!.n).toBe(0)
})
it('共享历史blob预览去重且只清自己的文件', async () => {
  const a = await file(), other = await file()
  const b = rollbackVersion(ctx, a.id, { expectedRevision: a.revision, expectedCurrentVersionId: a.currentVersionId }, a.currentVersionId!).asset
  const path = blob(a), otherPath = blob(other)
  expect(deletePreview(ctx, a.id)).toMatchObject({ versionCount: 2, fileCount: 1, fileBytes: 4 })
  expect(deleteAsset(ctx, a.id, b.revision, true).cleanupPending).toBe(false)
  expect(fs.existsSync(path)).toBe(false)
  expect(fs.readFileSync(otherPath, 'utf8')).toBe('blob')
})
it('SQL删除故障不清文件；文件清理失败返回已删除和cleanupPending', async () => {
  const a = await file(), path = blob(a)
  ctx.write(s => s.run("CREATE TRIGGER fail_delete BEFORE DELETE ON asset BEGIN SELECT RAISE(ABORT,'synthetic'); END"))
  expect(() => deleteAsset(ctx, a.id, a.revision, true)).toThrow('synthetic')
  expect(fs.existsSync(path)).toBe(true)
  ctx.write(s => s.run('DROP TRIGGER fail_delete'))
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw new Error('synthetic cleanup') })
  expect(deleteAsset(ctx, a.id, a.revision, true)).toEqual({ deletedId: a.id, cleanupPending: true })
  expect(fs.existsSync(path)).toBe(true)
  expect(() => getAsset(ctx, a.id)).toThrow()
})
it('孤儿和其他资产目录保留；junction不会被跟随清理', async () => {
  const a = await file(), other = await file()
  const dir = join(ctx.layout.filesDir, String(a.id))
  fs.writeFileSync(join(dir, 'unknown.bin'), 'keep')
  expect(deleteAsset(ctx, a.id, a.revision, true).cleanupPending).toBe(true)
  expect(fs.readFileSync(join(dir, 'unknown.bin'), 'utf8')).toBe('keep')
  const empty = createAsset(ctx, { name: 'Empty', category: 'inbox', storageType: 'file' })
  fs.symlinkSync(join(ctx.layout.filesDir, String(other.id)), join(ctx.layout.filesDir, String(empty.id)), 'junction')
  expect(deleteAsset(ctx, empty.id, 1, true).cleanupPending).toBe(true)
  expect(fs.readFileSync(blob(other), 'utf8')).toBe('blob')
})
it('跨资产数据库文件引用异常不删除受害blob', async () => {
  const victim = await file(), path = blob(victim)
  const a = createAsset(ctx, { name: 'Bad reference', category: 'inbox', storageType: 'file' })
  const rel = getVersion(ctx, victim.id, victim.currentVersionId!).version.filePath!
  ctx.write(s => s.run('INSERT INTO asset_version(asset_id,version,content,changelog,source_json,file_path,created_at) VALUES (?,?,?,?,?,?,?)', a.id, 1, '', '', '{}', rel, new Date().toISOString()))
  expect(() => deletePreview(ctx, a.id)).toThrow(/路径异常/)
  expect(deleteAsset(ctx, a.id, 1, true).cleanupPending).toBe(true)
  expect(fs.readFileSync(path, 'utf8')).toBe('blob')
  expect(getAsset(ctx, victim.id).versionCount).toBe(1)
})
it('空间代际改变后的旧上下文归档删除均零写入', async () => {
  const a = asset()
  epoch = 'A#2'
  for (const operation of [() => archiveAsset(ctx, a.id, 1), () => restoreAsset(ctx, a.id, 1), () => deleteAsset(ctx, a.id, 1, true)]) expect(operation).toThrow()
  const current = await manager.getForRequest(manager.context())
  expect(getAsset(current, a.id)).toEqual(a)
})
