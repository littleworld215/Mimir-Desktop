import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import { promises as fileIO } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, afterEach, it, expect, describe, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { AssetsStoreError, type AssetsContext } from '../../../electron/assets/types'
import { createAsset, updateAsset, getAsset } from '../../../electron/assets/assetService'
import { importFile, saveFile, listVersions, getVersion, diffVersions, rollbackVersion, sourceIsLink } from '../../../electron/assets/fileService'
import { resolveWithinFiles } from '../../../electron/assets/paths'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}
let root = ''
let manager: AssetsStoreManager
let ctx: AssetsContext
let epoch = 'A#1'
let workspaceId = 'A'
let db: Database.Database
beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'assets-file-'))
  epoch = 'A#1'
  workspaceId = 'A'
  manager = new AssetsStoreManager({ active: () => ({ id: workspaceId, path: root }), epoch: () => epoch }, (p, o) => {
    db = new Database(p, o)
    return db
  })
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => {
  vi.restoreAllMocks()
  await manager.close()
  fs.rmSync(root, { recursive: true, force: true })
})
function fileAsset() {
  return createAsset(ctx, { name: 'Doc', category: 'inbox', storageType: 'file' })
}
function srcFile(name = 'source.bin', content = 'blob-content'): string {
  const path = join(root, name)
  fs.writeFileSync(path, content)
  return path
}
function assertEmpty(id: number): void {
  expect(listVersions(ctx, id).total).toBe(0)
  expect(collectFiles(ctx.layout.filesDir)).toEqual([])
  expect(collectFiles(ctx.layout.stagingDir)).toEqual([])
}
const hash = (path: string): string => createHash('sha256').update(fs.readFileSync(path)).digest('hex')

describe('源文件实体校验', () => {
  it('链接及无法解析的 realpath 一律拒绝，普通路径按平台规范化', () => {
    const path = resolve(root, 'ordinary.bin')
    expect(sourceIsLink({ isSymbolicLink: () => true }, path, path)).toBe(true)
    expect(sourceIsLink({ isSymbolicLink: () => false }, null, path)).toBe(true)
    expect(sourceIsLink(null, null, path)).toBe(true)
    expect(sourceIsLink({ isSymbolicLink: () => false }, resolve(root, 'other'), path)).toBe(true)
    expect(sourceIsLink({ isSymbolicLink: () => false }, path, path)).toBe(false)
    if (process.platform === 'win32') expect(sourceIsLink({ isSymbolicLink: () => false }, path.toUpperCase(), path)).toBe(false)
  })
  it('真实 importFile 拒绝 lstat 符号链接分支，不依赖平台链接能力', async () => {
    const f = fileAsset()
    const source = srcFile()
    const original = fs.lstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
      const stat = original(path)
      if (String(path) === source) return new Proxy(stat, { get: (target, key) => key === 'isSymbolicLink' ? () => true : Reflect.get(target, key) })
      return stat
    }) as typeof fs.lstatSync)
    await expect(importFile(ctx, f.id, { expectedRevision: 1 }, source)).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
    assertEmpty(f.id)
  })
  it('真实 importFile realpath 失败 fail-closed', async () => {
    const f = fileAsset()
    const source = srcFile()
    vi.spyOn(fs, 'realpathSync').mockImplementation(() => { throw new Error('无法解析') })
    await expect(importFile(ctx, f.id, { expectedRevision: 1 }, source)).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
    assertEmpty(f.id)
  })
  it('缺失文件、目录、非法参数均拒绝且零版本', async () => {
    const f = fileAsset()
    await expect(importFile(ctx, f.id, { expectedRevision: 1 }, join(root, 'missing'))).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
    await expect(importFile(ctx, f.id, { expectedRevision: 1 }, root)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(importFile(ctx, f.id, { expectedRevision: 1 }, '')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    assertEmpty(f.id)
  })
})

it('合法父目录 realpath 别名允许导入，最终文件身份保持一致', async () => {
  const f = fileAsset()
  const source = srcFile()
  const original = fs.realpathSync
  const canonicalParent = join(root, 'canonical-parent')
  vi.spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike) => {
    if (String(path) === source) return join(canonicalParent, 'source.bin')
    if (String(path) === root) return canonicalParent
    return original(path)
  }) as typeof fs.realpathSync)
  const asset = await importFile(ctx, f.id, { expectedRevision: 1 }, source)
  expect(asset.versionCount).toBe(1)
})

it('源同长度 rename 替换拒绝且零入库（独立 QA 反例）', async () => {
  const f = fileAsset()
  const source = srcFile('source.bin', 'GOOD')
  const original = fs.read
  let replaced = false
  vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => {
    if (!replaced) {
      replaced = true
      fs.renameSync(source, source + '.original')
      fs.writeFileSync(source, 'EVIL')
    }
    return original(...args)
  }) as typeof fs.read)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, source)).rejects.toThrow()
  assertEmpty(f.id)
  expect(fs.readFileSync(source + '.original', 'utf8')).toBe('GOOD')
})
it('staging 真实 hardlink 替换不得覆盖或删除 victim（独立 QA 反例）', async () => {
  const f = fileAsset()
  const source = srcFile('source.bin', 'GOOD')
  const victim = srcFile('victim.bin', 'KEEP')
  const original = fs.read
  let stage = ''
  vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => {
    if (!stage) {
      stage = collectFiles(ctx.layout.stagingDir)[0]
      fs.unlinkSync(stage)
      fs.linkSync(victim, stage)
    }
    return original(...args)
  }) as typeof fs.read)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, source)).rejects.toThrow()
  expect(listVersions(ctx, f.id).total).toBe(0)
  expect(fs.readFileSync(victim, 'utf8')).toBe('KEEP')
  expect(fs.readFileSync(stage, 'utf8')).toBe('KEEP')
})

it('正常实际文件生命周期：独立 blob、原文件变化不影响历史、保存和回滚保持哈希', async () => {
  const f = fileAsset()
  expect(f).toMatchObject({ versionCount: 0, currentVersionId: null, fileAvailable: false })
  const source = srcFile('same.bin', 'v1')
  const a = await importFile(ctx, f.id, { expectedRevision: 1, expectedCurrentVersionId: null }, source, 'initial')
  const first = listVersions(ctx, f.id).items[0]
  const blob = resolveWithinFiles(ctx.layout, first.filePath!)
  const oldHash = hash(blob)
  fs.writeFileSync(source, 'v2')
  const b = await importFile(ctx, f.id, { expectedRevision: a.revision }, source)
  expect(b).toMatchObject({ versionCount: 2, currentVersion: 2, fileAvailable: true })
  expect(collectFiles(ctx.layout.filesDir)).toHaveLength(2)
  expect(hash(blob)).toBe(oldHash)
  expect(first.fileName).toBe('same.bin')
  expect(getVersion(ctx, f.id, a.currentVersionId!).version.content).toBe('')
  const destination = join(root, 'saved.bin')
  expect(saveFile(ctx, f.id, undefined, destination)).toEqual({ saved: true })
  expect(fs.readFileSync(destination, 'utf8')).toBe('v2')
  const rollback = rollbackVersion(ctx, f.id, { expectedRevision: b.revision }, a.currentVersionId!)
  expect(rollback.createdVersion.version).toBe(3)
  expect(rollback.asset.fileAvailable).toBe(true)
  expect(hash(blob)).toBe(oldHash)
  expect(diffVersions(ctx, f.id, a.currentVersionId!, b.currentVersionId!).diff).toMatchObject({ kind: 'file', lines: [] })
})

it('条件写拒绝陈旧 revision、显式 null 及错误版本，不留 staging 或新 blob', async () => {
  const f = fileAsset()
  const a = await importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())
  for (const [condition, code] of [
    [{ expectedRevision: 999 }, 'REVISION_CONFLICT'],
    [{ expectedRevision: a.revision, expectedCurrentVersionId: null }, 'VERSION_CONFLICT'],
    [{ expectedRevision: a.revision, expectedCurrentVersionId: 999 }, 'VERSION_CONFLICT']
  ] as const) {
    await expect(importFile(ctx, f.id, condition, srcFile())).rejects.toMatchObject({ code })
  }
  expect(getAsset(ctx, f.id)).toEqual(a)
  expect(collectFiles(ctx.layout.stagingDir)).toEqual([])
  expect(collectFiles(ctx.layout.filesDir)).toHaveLength(1)
})
it('非文件资产拒绝 importFile', async () => {
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'x' })
  await expect(importFile(ctx, t.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(getAsset(ctx, t.id)).toEqual(t)
  expect(collectFiles(ctx.layout.stagingDir)).toEqual([])
})
it('历史分页、完整版本与文本 diff/rollback 合同保留', async () => {
  const f = fileAsset()
  for (let i = 0; i < 5; i++) await importFile(ctx, f.id, { expectedRevision: i + 1 }, srcFile(`s${i}`, `v${i}`))
  expect(listVersions(ctx, f.id).items.map(v => v.version)).toEqual([5, 4, 3, 2, 1])
  expect(listVersions(ctx, f.id, 2, 2).items.map(v => v.version)).toEqual([3, 2])
  expect(() => listVersions(ctx, f.id, 0)).toThrow()
  expect(() => listVersions(ctx, f.id, 1, 201)).toThrow()
  expect(() => getVersion(ctx, f.id, 999)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'v1' })
  const b = updateAsset(ctx, t.id, { expectedRevision: t.revision, expectedCurrentVersionId: t.currentVersionId }, { content: 'v2' })
  expect(diffVersions(ctx, t.id, t.currentVersionId!, b.currentVersionId!).diff.lines.map(l => l.kind)).toEqual(['remove', 'add'])
  expect(rollbackVersion(ctx, t.id, { expectedRevision: b.revision }, t.currentVersionId!).asset).toMatchObject({ currentContent: 'v1', currentVersion: 3 })
})
it('缺失历史 blob 回滚零变化，fileAvailable 只派生不删历史', async () => {
  const f = fileAsset()
  const a = await importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())
  const oldVersion = getVersion(ctx, f.id, a.currentVersionId!).version
  fs.unlinkSync(resolveWithinFiles(ctx.layout, oldVersion.filePath!))
  expect(getAsset(ctx, f.id)).toMatchObject({ fileAvailable: false, versionCount: 1 })
  const before = getAsset(ctx, f.id)
  expect(() => rollbackVersion(ctx, f.id, { expectedRevision: a.revision }, a.currentVersionId!)).toThrow(expect.objectContaining({ code: 'FILE_UNAVAILABLE' }))
  expect(getAsset(ctx, f.id)).toEqual(before)
  expect(getVersion(ctx, f.id, a.currentVersionId!).version).toEqual(oldVersion)
})
it('文件与文本导出默认独占，既有目标及并发保存不可覆盖（R1）', async () => {
  const f = fileAsset()
  await importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())
  const t = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: 'body' })
  for (const asset of [f, t]) {
    const destination = join(root, `export-${asset.id}`)
    const outcomes = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => saveFile(ctx, asset.id, undefined, destination))))
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const savedHash = hash(destination)
    expect(() => saveFile(ctx, asset.id, undefined, destination)).toThrow(expect.objectContaining({ code: 'FILE_EXISTS' }))
    expect(hash(destination)).toBe(savedHash)
  }
})

it('文本版本导出字节一致且 fileAvailable 恒为 false', () => {
  const asset = createAsset(ctx, { name: 'T', category: 'inbox', storageType: 'inline_text', content: '正文\n' })
  const destination = join(root, 'text.txt')
  expect(saveFile(ctx, asset.id, undefined, destination)).toEqual({ saved: true })
  expect(fs.readFileSync(destination, 'utf8')).toBe('正文\n')
  expect(getAsset(ctx, asset.id).fileAvailable).toBe(false)
})
it('首次导入完整版本保留 changelog 与源文件名', async () => {
  const f = fileAsset()
  const a = await importFile(ctx, f.id, { expectedRevision: 1 }, srcFile('name.bin'), 'initial')
  expect(getVersion(ctx, f.id, a.currentVersionId!).version).toMatchObject({ fileName: 'name.bin', changelog: 'initial', version: 1 })
})
it('已归档资产导入拒绝且不产生暂存', async () => {
  const f = fileAsset()
  db.prepare('UPDATE asset SET archived_at=? WHERE id=?').run(new Date().toISOString(), f.id)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'ASSET_ARCHIVED' })
  assertEmpty(f.id)
})
it('不存在资产拒绝导入并清理暂存', async () => {
  await expect(importFile(ctx, 999, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(collectFiles(ctx.layout.stagingDir)).toEqual([])
  expect(collectFiles(ctx.layout.filesDir)).toEqual([])
})
it('显式正确版本条件接受追加导入', async () => {
  const f = fileAsset()
  const a = await importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())
  const b = await importFile(ctx, f.id, { expectedRevision: a.revision, expectedCurrentVersionId: a.currentVersionId }, srcFile())
  expect(b.currentVersion).toBe(2)
})
it('源文件超限由主进程拒绝，不进行复制', async () => {
  const f = fileAsset()
  const source = srcFile()
  const original = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
    const stat = original(path)
    return String(path) === source ? new Proxy(stat, { get: (target, key) => key === 'size' ? 201 * 1024 * 1024 : Reflect.get(target, key) }) : stat
  }) as typeof fs.lstatSync)
  const copy = vi.spyOn(fileIO, 'copyFile')
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, source)).rejects.toThrow()
  expect(copy).not.toHaveBeenCalled()
  assertEmpty(f.id)
})
it('排他落盘故障精确清理 staging', async () => {
  const f = fileAsset()
  vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw new Error('搬入失败') })
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'WRITE_FAILED' })
  assertEmpty(f.id)
})

it('最终路径在落盘前被外部创建时不覆盖或删除外部文件', async () => {
  const f = fileAsset()
  const rename = fs.renameSync
  const link = fs.linkSync
  let foreign = ''
  const occupy = (destination: fs.PathLike) => {
    foreign = String(destination)
    fs.writeFileSync(foreign, 'foreign-final-bytes')
  }
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    occupy(to)
    return rename(from, to)
  })
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    occupy(to)
    return link(from, to)
  })
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'WRITE_FAILED' })
  expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign-final-bytes')
  expect(listVersions(ctx, f.id).total).toBe(0)
  expect(collectFiles(ctx.layout.stagingDir)).toEqual([])
  expect(collectFiles(ctx.layout.filesDir)).toEqual([foreign])
})

it('暂存被同 inode 同长度改写时拒绝提交并清理本次文件', async () => {
  const f = fileAsset()
  const read = fs.read
  let replaced = false
  vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => {
    const callback = args[args.length - 1] as (error: NodeJS.ErrnoException | null, bytes: number, buffer: Buffer) => void
    args[args.length - 1] = ((error: NodeJS.ErrnoException | null, bytes: number, buffer: Buffer) => {
      if (error === null && bytes === 0 && !replaced) {
        replaced = true
        fs.writeFileSync(collectFiles(ctx.layout.stagingDir)[0], 'EVIL')
      }
      callback(error, bytes, buffer)
    }) as typeof callback
    return read(...args)
  }) as typeof fs.read)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile('source', 'GOOD'))).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
  assertEmpty(f.id)
})
it('暂存被替换成符号链接时拒绝提交', async () => {
  const f = fileAsset()
  const original = fs.lstatSync
  let injected = false
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
    const stat = original(path)
    if (String(path).includes('staging') && !injected) {
      injected = true
      return new Proxy(stat, { get: (target, key) => key === 'isFile' ? () => false : Reflect.get(target, key) })
    }
    return stat
  }) as typeof fs.lstatSync)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
  assertEmpty(f.id)
})

it('异步复制部分输出后失败必须清理暂存且零版本（R2 红例）', async () => {
  const f = fileAsset()
  const descriptors: number[] = []
  const originalOpen = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args)
    descriptors.push(fd)
    return fd
  }) as typeof fs.openSync)
  const originalWrite = fs.write
  let written = false
  vi.spyOn(fs, 'write').mockImplementation(((...args: Parameters<typeof fs.write>) => {
    if (written) { const callback = args[args.length - 1] as (error: Error) => void; callback(new Error('复制中断')); return }
    written = true
    return originalWrite(...args)
  }) as typeof fs.write)
  const source = srcFile('large.bin', 'x'.repeat(128 * 1024))
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, source)).rejects.toThrow('复制中断')
  for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow()
  assertEmpty(f.id)
})
it('源同 inode 内容变化拒绝，成功及复制中断均释放全部 descriptor', async () => {
  const f = fileAsset()
  const source = srcFile('mutable.bin', 'GOOD')
  const descriptors: number[] = []
  const open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args)
    descriptors.push(fd)
    return fd
  }) as typeof fs.openSync)
  const read = fs.read
  let changed = false
  vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => {
    if (!changed) { changed = true; fs.writeFileSync(source, 'EVIL-LONGER') }
    return read(...args)
  }) as typeof fs.read)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, source)).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
  for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow()
  assertEmpty(f.id)
})
it('普通多块复制成功释放源和暂存 descriptor', async () => {
  const f = fileAsset()
  const descriptors: number[] = []
  const open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args)
    descriptors.push(fd)
    return fd
  }) as typeof fs.openSync)
  const source = srcFile('multiblock', 'x'.repeat(200 * 1024))
  await importFile(ctx, f.id, { expectedRevision: 1 }, source)
  for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow()
  expect(fs.readFileSync(collectFiles(ctx.layout.filesDir)[0])).toEqual(fs.readFileSync(source))
})

it('实际复制大小不符必须拒绝且清理', async () => {
  const f = fileAsset()
  vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => {
    const callback = args[args.length - 1] as (error: null, count: number) => void
    callback(null, 0)
  }) as typeof fs.read)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
  assertEmpty(f.id)
})
it('staging 独占创建失败不删除他人文件', async () => {
  const f = fileAsset()
  const foreign = join(ctx.layout.stagingDir, 'foreign')
  fs.writeFileSync(foreign, 'other')
  const originalOpen = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes('staging')) throw Object.assign(new Error('已存在'), { code: 'EEXIST' })
    return originalOpen(...args)
  }) as typeof fs.openSync)
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toThrow()
  expect(fs.readFileSync(foreign, 'utf8')).toBe('other')
  expect(listVersions(ctx, f.id).total).toBe(0)
})
it('清理失败如实返回 WRITE_FAILED，不谎称清理成功', async () => {
  const f = fileAsset()
  vi.spyOn(fs, 'read').mockImplementation(() => { throw new Error('复制中断') })
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('清理被拒绝'), { code: 'EPERM' }) })
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'WRITE_FAILED', message: expect.stringContaining('清理未完成') })
  expect(listVersions(ctx, f.id).total).toBe(0)
})
it('rename 后真实 SQLite INSERT trigger 失败清理新 blob，保留旧哈希', async () => {
  const f = fileAsset()
  const a = await importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())
  const blob = collectFiles(ctx.layout.filesDir)[0]
  const oldHash = hash(blob)
  db.exec("CREATE TRIGGER injected_insert BEFORE INSERT ON asset_version BEGIN SELECT RAISE(ABORT, '注入 SQL 故障'); END")
  await expect(importFile(ctx, f.id, { expectedRevision: a.revision }, srcFile('second', 'new'))).rejects.toThrow()
  expect(getAsset(ctx, f.id)).toEqual(a)
  expect(collectFiles(ctx.layout.stagingDir)).toEqual([])
  expect(collectFiles(ctx.layout.filesDir)).toEqual([blob])
  expect(hash(blob)).toBe(oldHash)
})
it('真实 SQLite deferred FK 导致 COMMIT 失败后清理新 blob', async () => {
  const f = fileAsset()
  db.exec('CREATE TABLE fault_parent(id INTEGER PRIMARY KEY); CREATE TABLE fault_child(id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fault_commit AFTER INSERT ON asset_version BEGIN INSERT INTO fault_child VALUES(999); END')
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toThrow()
  assertEmpty(f.id)
  expect(db.prepare('SELECT count(*) n FROM fault_child').get()).toEqual({ n: 0 })
})
it('事务回调后最终 scope 检查失败真实回滚并清理 blob', async () => {
  const f = fileAsset()
  const write = ctx.write
  ctx.write = operation => write(session => {
    const value = operation(session)
    epoch = 'A#2'
    return value
  })
  await expect(importFile(ctx, f.id, { expectedRevision: 1 }, srcFile())).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
  expect(db.prepare('SELECT count(*) n FROM asset_version').get()).toEqual({ n: 0 })
  expect(collectFiles(ctx.layout.filesDir)).toEqual([])
  expect(collectFiles(ctx.layout.stagingDir)).toEqual([])
})
it('提交后 manager.run 响应 scope 失败保留已引用 blob 及哈希', async () => {
  const f = fileAsset()
  let committedHash = ''
  await expect(manager.run(manager.context(), async context => {
    const asset = await importFile(context, f.id, { expectedRevision: 1 }, srcFile())
    committedHash = hash(collectFiles(context.layout.filesDir)[0])
    epoch = 'A#2'
    return asset
  })).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
  expect(db.prepare('SELECT count(*) n FROM asset_version').get()).toEqual({ n: 1 })
  const paths = collectFiles(ctx.layout.filesDir)
  expect(paths).toHaveLength(1)
  expect(hash(paths[0])).toBe(committedHash)
})
it('异步 copy 期间切空间排空任务，拒绝旧 scope，A→B→A 不复活', async () => {
  const f = fileAsset()
  const scope = manager.context()
  const originalCopy = fs.read
  let finish!: () => void
  let started!: () => void
  const copying = new Promise<void>(r => { started = r })
  const gate = new Promise<void>(r => { finish = r })
  vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => {
    started()
    void gate.then(() => originalCopy(...args))
  }) as typeof fs.read)
  const operation = manager.run(scope, context => importFile(context, f.id, { expectedRevision: 1 }, srcFile()))
  const rejected = expect(operation).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
  await copying
  const switching = manager.beforeSpaceSwitch()
  finish()
  await rejected
  await switching
  workspaceId = 'B'
  epoch = 'B#2'
  manager.afterSpaceSwitch()
  workspaceId = 'A'
  epoch = 'A#3'
  await expect(manager.run(scope, async () => undefined)).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
  ctx = await manager.getForRequest(manager.context())
  assertEmpty(f.id)
})
