import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { appendWorkspaceRecord } from '../../../electron/workspaceBackup/registryAppend'
import { captureProtectedSnapshot, publishProtectedRegistry, readRegistryForAppend } from '../../../electron/workspaceBackup/protectedRegistry'

const control = vi.hoisted(() => ({ deny: false, denyPublished: false, tamperPublished: false, io: '', files: new Map<number, string>(), onNative: undefined as (() => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (path: string, flags: string, mode?: number) => {
      if (flags === 'wx' && control.io === 'collision' && path.includes('restore-registry-snapshots') && path.endsWith('.bak')) fs.writeFileSync(path, 'FOREIGN-SYNTHETIC')
      const fd = fs.openSync(path, flags, mode)
      if (flags === 'wx' && path.includes('restore-registry-snapshots')) control.files.set(fd, path)
      return fd
    },
    writeFileSync: (fd: number | string, data: string | Buffer, options?: import('node:fs').WriteFileOptions) => {
      if (typeof fd === 'number' && control.files.has(fd) && control.io === 'write') throw Object.assign(new Error('synthetic write'), { code: 'EIO' })
      fs.writeFileSync(fd, data, options)
    },
    fsyncSync: (fd: number) => {
      if (control.files.has(fd) && control.io === 'sync') throw Object.assign(new Error('synthetic sync'), { code: 'EIO' })
      fs.fsyncSync(fd)
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd)
      const owned = control.files.delete(fd)
      if (owned && control.io === 'close') throw Object.assign(new Error('synthetic close'), { code: 'EIO' })
    },
    renameSync: (from: string, to: string) => {
      if (control.io === 'rename' && to.replace(/\\/g, '/').endsWith('/.mimir/store.json')) throw Object.assign(new Error('synthetic rename'), { code: 'EIO' })
      fs.renameSync(from, to)
    }
  }
})
vi.mock('node:child_process', async original => {
  const cp = await original<typeof import('node:child_process')>()
  return { ...cp, spawnSync: (file: string, args: readonly string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => {
    if (options?.env?.MIMIR_REGISTRY_ACL_PATH) {
      if (control.deny || (control.denyPublished && options.env.MIMIR_REGISTRY_ACL_PATH.replace(/\\/g, '/').endsWith('/.mimir/store.json'))) return { pid: 0, output: [null, '', ''], stdout: '', stderr: 'synthetic denied', status: 1, signal: null }
      const result = cp.spawnSync(file, args, options)
      if (control.tamperPublished && options.env.MIMIR_REGISTRY_ACL_PATH.replace(/\\/g, '/').endsWith('/.mimir/store.json')) writeFileSync(options.env.MIMIR_REGISTRY_ACL_PATH, 'CHANGED-AFTER-PUBLISH-SYNTHETIC')
      const callback = control.onNative; control.onNative = undefined; callback?.()
      return result
    }
    return cp.spawnSync(file, args, options)
  } }
})
const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mimir-private-registry-')); roots.push(home)
  mkdirSync(join(home, '.mimir'))
  const registry = join(home, '.mimir', 'store.json')
  const original = Buffer.from('{ "settings": { "apiKey": "SYNTHETIC-G07-SECRET" }, "activeWorkspaceId": "old", "defaultWorkspaceId": "old", "workspaces:list": [] }\n')
  writeFileSync(registry, original)
  const input = { id: 'new', name: '恢复空间', path: join(home, 'restored'), createdAt: '2026-10-26', updatedAt: '2026-10-26' }
  mkdirSync(input.path)
  return { home, registry, original, input }
}
afterEach(() => {
  control.deny = false; control.denyPublished = false; control.tamperPublished = false; control.io = ''; control.files.clear(); control.onNative = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('Windows权限设置或回读失败时原登记不变，未保护的父目录不落凭据', () => {
  if (process.platform !== 'win32') return
  const f = fixture(); control.deny = true
  expect(() => appendWorkspaceRecord(f.home, f.input)).toThrow()
  expect(readFileSync(f.registry)).toEqual(f.original)
  const names = readdirSync(join(f.home, '.mimir'))
  expect(names.filter(n => n !== 'store.json' && n !== 'restore-registry-snapshots')).toEqual([])
})

it('初次空目录保护失败后可重新登记，不自动修复既有目录', () => {
  if (process.platform !== 'win32') return
  const f = fixture(); control.deny = true
  expect(() => appendWorkspaceRecord(f.home, f.input)).toThrow()
  expect(readFileSync(f.registry)).toEqual(f.original)
  control.deny = false
  expect(appendWorkspaceRecord(f.home, f.input)).toMatchObject({ appended: true })
})

it('快照位于私有目录且逐字节保留原文，追加不改原配置或激活指针', () => {
  const f = fixture()
  const result = appendWorkspaceRecord(f.home, f.input)
  expect(dirname(result.snapshotPath)).toBe(join(f.home, '.mimir', 'restore-registry-snapshots'))
  expect(readFileSync(result.snapshotPath)).toEqual(f.original)
  expect(JSON.parse(readFileSync(f.registry, 'utf8'))).toMatchObject({ settings: { apiKey: 'SYNTHETIC-G07-SECRET' }, activeWorkspaceId: 'old', defaultWorkspaceId: 'old', 'workspaces:list': [f.input] })
  const before = readdirSync(dirname(result.snapshotPath)).sort()
  expect(appendWorkspaceRecord(f.home, f.input)).toMatchObject({ appended: false, snapshotPath: '' })
  expect(readdirSync(dirname(result.snapshotPath)).sort()).toEqual(before)
})

it('既有宽松私有目录不自动收权或继续写入，旧平铺快照不动', () => {
  const f = fixture(), privateDir = join(f.home, '.mimir', 'restore-registry-snapshots')
  mkdirSync(privateDir, { mode: 0o777 })
  const legacy = join(f.home, '.mimir', 'store.json.pre-restore-legacy.bak')
  writeFileSync(legacy, 'OLD-SYNTHETIC')
  expect(() => appendWorkspaceRecord(f.home, f.input)).toThrow()
  expect(readFileSync(f.registry)).toEqual(f.original)
  expect(readFileSync(legacy, 'utf8')).toBe('OLD-SYNTHETIC')
  expect(readdirSync(privateDir)).toEqual([])
})

it('私有目录junction拒绝，外部目标无凭据文件', () => {
  const f = fixture(), external = join(f.home, 'external')
  mkdirSync(external)
  symlinkSync(external, join(f.home, '.mimir', 'restore-registry-snapshots'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => appendWorkspaceRecord(f.home, f.input)).toThrow()
  expect(readFileSync(f.registry)).toEqual(f.original)
  expect(readdirSync(external)).toEqual([])
})

it('原登记在权限准备期间被改，保留外来字节而不登记', () => {
  if (process.platform !== 'win32') return
  const f = fixture(), changed = Buffer.from('{"workspaces:list":[],"external":"preserve"}')
  control.onNative = () => writeFileSync(f.registry, changed)
  expect(() => appendWorkspaceRecord(f.home, f.input)).toThrowError(expect.objectContaining({ code: 'REGISTRY_CHANGED' }))
  expect(readFileSync(f.registry)).toEqual(changed)
})

it.each(['write', 'sync', 'close', 'rename'])('%s失败不改原登记，已恢复的新目录保留', operation => {
  const f = fixture(); control.io = operation
  expect(() => appendWorkspaceRecord(f.home, f.input)).toThrow()
  expect(readFileSync(f.registry)).toEqual(f.original)
  expect(readdirSync(f.input.path)).toEqual([])
  expect(readdirSync(join(f.home, '.mimir')).filter(n => n.startsWith('.tmp'))).toEqual([])
})

it('登记已发布后的权限回读失败不假装回滚，已验证原字节快照仍保留', () => {
  if (process.platform !== 'win32') return
  const f = fixture(); control.denyPublished = true
  let failure: unknown
  try { appendWorkspaceRecord(f.home, f.input) } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'REGISTRY_PROTECTION_FAILED', message: expect.stringContaining('登记已发布') })
  expect(JSON.parse(readFileSync(f.registry, 'utf8'))['workspaces:list']).toEqual([f.input])
  const directory = join(f.home, '.mimir', 'restore-registry-snapshots')
  const snapshots = readdirSync(directory).filter(n => n.endsWith('.bak'))
  expect(snapshots).toHaveLength(1)
  expect(readFileSync(join(directory, snapshots[0]))).toEqual(f.original)
})

it('同名独占创建冲突不覆盖或删除已有文件', () => {
  const f = fixture(); control.io = 'collision'
  expect(() => appendWorkspaceRecord(f.home, f.input)).toThrow()
  expect(readFileSync(f.registry)).toEqual(f.original)
  const directory = join(f.home, '.mimir', 'restore-registry-snapshots')
  const files = readdirSync(directory)
  expect(files).toHaveLength(1)
  expect(readFileSync(join(directory, files[0]), 'utf8')).toBe('FOREIGN-SYNTHETIC')
})

it('登记发布后内容核对失败回执明确已发布，保留外来改写及原字节快照', () => {
  if (process.platform !== 'win32') return
  const f = fixture(); control.tamperPublished = true
  let failure: unknown
  try { appendWorkspaceRecord(f.home, f.input) } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'REGISTRY_CHANGED', message: expect.stringContaining('登记已发布') })
  expect(readFileSync(f.registry, 'utf8')).toBe('CHANGED-AFTER-PUBLISH-SYNTHETIC')
  const directory = join(f.home, '.mimir', 'restore-registry-snapshots')
  const files = readdirSync(directory).filter(n => n.endsWith('.bak'))
  expect(files).toHaveLength(1)
  expect(readFileSync(join(directory, files[0]))).toEqual(f.original)
})

it('登记沿用捕获快照的截止点，过期后不重新获得ACL预算', () => {
  if (process.platform !== 'win32') return
  const f = fixture(), source = readRegistryForAppend(f.home), snapshot = captureProtectedSnapshot(f.home, source)
  snapshot.aclDeadline = performance.now() - 1
  expect(() => publishProtectedRegistry(f.home, { ...source.value, 'workspaces:list': [f.input] }, source, snapshot))
    .toThrowError(expect.objectContaining({ code: 'REGISTRY_PROTECTION_FAILED' }))
  expect(readFileSync(f.registry)).toEqual(f.original)
  expect(readFileSync(snapshot.path)).toEqual(f.original)
})

it('捕获后快照被改写时不能登记，原本机登记字节保留', () => {
  const f = fixture(), source = readRegistryForAppend(f.home), snapshot = captureProtectedSnapshot(f.home, source)
  writeFileSync(snapshot.path, 'CHANGED-SYNTHETIC')
  expect(() => publishProtectedRegistry(f.home, { ...source.value, 'workspaces:list': [f.input] }, source, snapshot))
    .toThrowError(expect.objectContaining({ code: 'REGISTRY_CHANGED' }))
  expect(readFileSync(f.registry)).toEqual(f.original)
})
