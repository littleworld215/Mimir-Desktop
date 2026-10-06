import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, updateAsset, getAsset } from '../../../electron/assets/assetService'
import {
  importFile,
  saveFile,
  listVersions,
  getVersion,
  diffVersions,
  rollbackVersion
} from '../../../electron/assets/fileService'
import { assetsLayout, resolveWithinFiles } from '../../../electron/assets/paths'

let root = ''
let manager: AssetsStoreManager
let ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-file-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => {
  await manager.close()
  rmSync(root, { recursive: true, force: true })
})

function fileAsset(extra: Record<string, unknown> = {}) {
  return createAsset(ctx, { name: 'Doc', category: 'inbox', storageType: 'file', ...extra })
}
function srcFile(name: string, content: string): string {
  const p = join(root, name)
  writeFileSync(p, content)
  return p
}

it('importFile 为文件资产建 v1，fileAvailable 派生为 true，blob 落盘', () => {
  const f = fileAsset()
  expect(f).toMatchObject({ versionCount: 0, currentVersionId: null, fileAvailable: false })
  const src = srcFile('src1.bin', 'hello-blob-1')
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, src, 'initial')
  expect(a).toMatchObject({ versionCount: 1, currentVersion: 1, fileAvailable: true })
  const rel = listVersions(ctx, f.id).items[0]
  expect(rel.fileName).toBe('src1.bin')
  expect(rel.filePath).not.toBeNull()
  const abs = resolveWithinFiles(assetsLayout(root), rel.filePath as string)
  expect(existsSync(abs)).toBe(true)
  expect(readFileSync(abs, 'utf8')).toBe('hello-blob-1')
})

it('再次 importFile 追加 v2，当前版本前移，fileAvailable 仍为 true', () => {
  const f = fileAsset()
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s1', 'v1'), 'first')
  const b = importFile(ctx, f.id, { expectedRevision: a.revision }, srcFile('s2', 'v2'), 'second')
  expect(b).toMatchObject({ versionCount: 2, currentVersion: 2, fileAvailable: true })
  const page = listVersions(ctx, f.id)
  expect(page.total).toBe(2)
  expect(page.items.map((v) => v.version)).toEqual([2, 1]) // 倒序
})

it('importFile 拒绝非文件资产与缺失源文件与陈旧 revision', () => {
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'x' })
  expect(() => importFile(ctx, t.id, { expectedRevision: t.revision }, srcFile('s', 'x'))).toThrow()
  const f = fileAsset()
  expect(() => importFile(ctx, f.id, { expectedRevision: f.revision }, join(root, 'nope.bin'))).toThrow(
    expect.objectContaining({ code: 'FILE_UNAVAILABLE' })
  )
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s', 'v1'))
  expect(() => importFile(ctx, f.id, { expectedRevision: 999 }, srcFile('s2', 'v2'))).toThrow(
    expect.objectContaining({ code: 'REVISION_CONFLICT' })
  )
  // 陈旧 revision 不产生任何版本，也不产生孤儿 blob
  expect(listVersions(ctx, f.id).total).toBe(1)
})

it('importFile 接受显式 expectedCurrentVersionId 条件', () => {
  const f = fileAsset()
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s', 'v1'))
  expect(() =>
    importFile(ctx, f.id, { expectedRevision: a.revision, expectedCurrentVersionId: 999 }, srcFile('s2', 'v2'))
  ).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }))
  const ok = importFile(ctx, f.id, { expectedRevision: a.revision, expectedCurrentVersionId: a.currentVersionId }, srcFile('s2', 'v2'))
  expect(ok.currentVersion).toBe(2)
})

it('saveFile 把当前文件版本落盘到目标路径，字节一致（默认取当前版本）', () => {
  const f = fileAsset()
  importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s1', 'v1-content'))
  importFile(ctx, f.id, { expectedRevision: 2 }, srcFile('s2', 'v2-content'))
  const dest = join(root, 'out.bin')
  const res = saveFile(ctx, f.id, undefined, dest)
  expect(res).toEqual({ saved: true })
  expect(readFileSync(dest, 'utf8')).toBe('v2-content')
})

it('saveFile 文本版本写出正文到目标路径', () => {
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'body-text' })
  const dest = join(root, 'out.txt')
  expect(saveFile(ctx, t.id, undefined, dest)).toEqual({ saved: true })
  expect(readFileSync(dest, 'utf8')).toBe('body-text')
})

it('listVersions 分页：总条数与倒序正确，越界参数拒绝', () => {
  const f = fileAsset()
  for (let i = 0; i < 5; i++) importFile(ctx, f.id, { expectedRevision: f.revision + i }, srcFile(`s${i}`, `v${i}`))
  const all = listVersions(ctx, f.id)
  expect(all.total).toBe(5)
  expect(all.items.map((v) => v.version)).toEqual([5, 4, 3, 2, 1])
  const first = listVersions(ctx, f.id, 1, 2)
  expect(first.items.map((v) => v.version)).toEqual([5, 4])
  const second = listVersions(ctx, f.id, 2, 2)
  expect(second.items.map((v) => v.version)).toEqual([3, 2])
  expect(() => listVersions(ctx, f.id, 0, 50)).toThrow()
  expect(() => listVersions(ctx, f.id, 1, 201)).toThrow()
})

it('getVersion 返回完整版本（含正文/源），缺失版本 NOT_FOUND', () => {
  const f = fileAsset()
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s', 'blob'))
  const v = getVersion(ctx, f.id, a.currentVersionId as number).version
  expect(v).toMatchObject({ version: 1, content: '', filePath: a.currentFileName ? expect.anything() : null })
  expect(() => getVersion(ctx, f.id, 999)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
})

it('diffVersions 文本版本逐行 diff；文件版本返回 kind=file', () => {
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'v1' })
  const b = updateAsset(ctx, t.id, { expectedRevision: t.revision, expectedCurrentVersionId: t.currentVersionId }, { content: 'v2' })
  const v1 = t.currentVersionId as number
  const v2 = b.currentVersionId as number
  const diff = diffVersions(ctx, t.id, v1, v2).diff
  expect(diff.kind).toBe('text')
  const kinds = diff.lines.map((l) => l.kind)
  expect(kinds).toContain('remove')
  expect(kinds).toContain('add')

  const f = fileAsset()
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s1', 'x'))
  const c = importFile(ctx, f.id, { expectedRevision: 2 }, srcFile('s2', 'y'))
  const fd = diffVersions(ctx, f.id, a.currentVersionId as number, c.currentVersionId as number).diff
  expect(fd.kind).toBe('file')
  expect(fd.lines).toEqual([])
})

it('rollbackVersion 文本：以旧版本内容生成新版本，revision 递增', () => {
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'v1' })
  const b = updateAsset(ctx, t.id, { expectedRevision: t.revision, expectedCurrentVersionId: t.currentVersionId }, { content: 'v2' })
  const r = rollbackVersion(ctx, t.id, { expectedRevision: b.revision }, t.currentVersionId as number)
  expect(r.createdVersion.version).toBe(3)
  expect(r.asset).toMatchObject({ currentVersion: 3, currentContent: 'v1', revision: b.revision + 1 })
})

it('rollbackVersion 文件：复用不可变 blob，fileAvailable 仍为 true', () => {
  const f = fileAsset()
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s1', 'v1-blob'))
  const c = importFile(ctx, f.id, { expectedRevision: a.revision }, srcFile('s2', 'v2-blob'))
  const r = rollbackVersion(ctx, f.id, { expectedRevision: c.revision }, a.currentVersionId as number)
  expect(r.createdVersion.version).toBe(3)
  expect(r.asset).toMatchObject({ currentVersion: 3, fileAvailable: true })
  // 回滚后的当前版本应指向 v1 的 blob 内容
  const dest = join(root, 'rollback-out.bin')
  saveFile(ctx, f.id, undefined, dest)
  expect(readFileSync(dest, 'utf8')).toBe('v1-blob')
})

it('fileAvailable 推导：blob 被删后 getAsset 返回 false，且不影响版本计数', () => {
  const f = fileAsset()
  const a = importFile(ctx, f.id, { expectedRevision: f.revision }, srcFile('s1', 'v1'))
  expect(getAsset(ctx, f.id).fileAvailable).toBe(true)
  const rel = listVersions(ctx, f.id).items[0]
  const abs = resolveWithinFiles(assetsLayout(root), rel.filePath as string)
  unlinkSync(abs)
  expect(existsSync(abs)).toBe(false)
  const after = getAsset(ctx, f.id)
  expect(after.fileAvailable).toBe(false)
  expect(after.versionCount).toBe(1) // 仅 blob 缺失，版本元数据仍在
})

it('非文件资产 fileAvailable 恒为 false', () => {
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'x' })
  expect(getAsset(ctx, t.id).fileAvailable).toBe(false)
})
