/** 注册凭据专用I/O；绝不替换空间JSON的通用写入器。 */
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { RestoreError } from './restoreContracts'
import { registryOverviewFromValue } from './registryView'
import { assertPlainRegistryPath, protectNewPrivateDirectory, protectNewPrivateFile, verifyPrivatePath } from './privateRegistryAcl'
import { markMaintenanceCleanupFailure } from './maintenanceTask'

export const REGISTRY_PRIVATE_DIRECTORY = 'restore-registry-snapshots'
export interface RegistryFileStamp { dev: string; ino: string; birth: string; mtime: string; ctime: string; size: number }
interface FileReceipt { bytes: Buffer; stamp: RegistryFileStamp; sha256: string }
export interface RegistrySourceReceipt extends FileReceipt {
  value: Record<string, unknown>
  controlIdentity: string
  lock?: FileReceipt
}
export interface ProtectedSnapshotReceipt {
  path: string
  stamp: RegistryFileStamp
  sourceSha256: string
  aclDeadline: number
  directoryIdentity: string
}
const sourcePath = (home: string) => join(home, '.mimir', 'store.json')
const changed = () => new RestoreError('REGISTRY_CHANGED', '本机登记或保护快照已变化，未继续写入；请重新检查维护记录。')
const failed = () => new RestoreError('REGISTER_FAILED', '本机登记写入未完成，保护资料已保留，请重新检查维护记录。')
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function stamp(s: BigIntStats): RegistryFileStamp {
  if (s.size < 0n || s.size > 64n * 1024n * 1024n) throw changed()
  return { dev: String(s.dev), ino: String(s.ino), birth: String(s.birthtimeNs), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), size: Number(s.size) }
}
const equalStamp = (a: RegistryFileStamp, b: RegistryFileStamp) => JSON.stringify(a) === JSON.stringify(b)
const identity = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.birthtimeNs}`
const fileIdentity = (s: RegistryFileStamp) => `${s.dev}:${s.ino}:${s.birth}`

function readBoundFile(path: string): FileReceipt {
  const before = stamp(assertPlainRegistryPath(path, 'file'))
  const fd = openSync(path, 'r')
  let bytes: Buffer
  try {
    if (!equalStamp(before, stamp(fstatSync(fd, { bigint: true })))) throw changed()
    bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (n === 0) throw changed()
      offset += n
    }
    const tail = Buffer.alloc(1)
    if (readSync(fd, tail, 0, 1, null) !== 0 || !equalStamp(before, stamp(fstatSync(fd, { bigint: true })))) throw changed()
  } finally {
    try { closeSync(fd) } catch (error) { markMaintenanceCleanupFailure(); throw error }
  }
  const after = stamp(assertPlainRegistryPath(path, 'file'))
  if (!equalStamp(before, after)) throw changed()
  return { bytes: bytes!, stamp: after, sha256: digest(bytes!) }
}
function readLock(home: string): FileReceipt | undefined {
  const path = join(home, '.mimir', 'registry.writer-lock')
  try { lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  return readBoundFile(path)
}
export function readRegistryForAppend(homeDir: string): RegistrySourceReceipt {
  try {
    const controlIdentity = identity(assertPlainRegistryPath(join(homeDir, '.mimir'), 'directory'))
    const receipt = readBoundFile(sourcePath(homeDir)), value: unknown = JSON.parse(receipt.bytes.toString('utf8'))
    registryOverviewFromValue(value)
    return { ...receipt, value: value as Record<string, unknown>, controlIdentity, lock: readLock(homeDir) }
  } catch (error) {
    if (error instanceof RestoreError) throw error
    throw new RestoreError('REGISTRY_INVALID', '现有本机登记未通过读取验证，未修改原文件。')
  }
}
function assertSource(home: string, source: RegistrySourceReceipt): void {
  if (identity(assertPlainRegistryPath(join(home, '.mimir'), 'directory')) !== source.controlIdentity) throw changed()
  const now = readBoundFile(sourcePath(home)), lock = readLock(home)
  if (!equalStamp(now.stamp, source.stamp) || now.sha256 !== source.sha256 || Boolean(lock) !== Boolean(source.lock)
    || (lock && source.lock && (!equalStamp(lock.stamp, source.lock.stamp) || lock.sha256 !== source.lock.sha256))) throw changed()
}
function unlinkOwned(path: string, owned: string): void {
  try {
    const current = assertPlainRegistryPath(path, 'file')
    if (identity(current) !== owned) throw changed()
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { markMaintenanceCleanupFailure(); throw error }
  }
}
function writeCredentialFile(path: string, bytes: Buffer, deadline: number): FileReceipt {
  let fd: number | undefined, owned: string | undefined
  try {
    fd = openSync(path, 'wx', 0o600)
    owned = identity(fstatSync(fd, { bigint: true }))
    writeFileSync(fd, bytes); fsyncSync(fd)
    try { closeSync(fd) } catch (error) { markMaintenanceCleanupFailure(); throw error }
    fd = undefined
    protectNewPrivateFile(path, deadline)
    const result = readBoundFile(path)
    if (fileIdentity(result.stamp) !== owned || result.sha256 !== digest(bytes)) throw changed()
    return result
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { markMaintenanceCleanupFailure() } }
    if (owned) unlinkOwned(path, owned)
    throw error
  }
}
function preserveError(error: unknown): never { if (error instanceof RestoreError) throw error; throw failed() }

/** 空私有目录先保护/回读；快照发布前核对原字节，历史快照从不迁移或修权。 */
export function captureProtectedSnapshot(homeDir: string, source: RegistrySourceReceipt): ProtectedSnapshotReceipt {
  const aclDeadline = performance.now() + 10_000, directory = join(homeDir, '.mimir', REGISTRY_PRIVATE_DIRECTORY)
  let createdIdentity: string | undefined
  try {
    assertSource(homeDir, source)
    let created = false
    try { mkdirSync(directory, { mode: 0o700 }); created = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const before = identity(assertPlainRegistryPath(directory, 'directory'))
    if (created) createdIdentity = before
    if (created) protectNewPrivateDirectory(directory, aclDeadline)
    else verifyPrivatePath(directory, 'directory', aclDeadline)
    if (identity(assertPlainRegistryPath(directory, 'directory')) !== before) throw changed()
    assertSource(homeDir, source)
    const path = join(directory, `store.json.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`)
    const receipt = writeCredentialFile(path, source.bytes, aclDeadline)
    return { path, stamp: receipt.stamp, sourceSha256: source.sha256, aclDeadline, directoryIdentity: before }
  } catch (error) {
    // 初次保护失败时允许重试；绝不修复/删除既有目录，或递归清理未知内容。
    if (createdIdentity) {
      try {
        if (identity(assertPlainRegistryPath(directory, 'directory')) === createdIdentity
          && readdirSync(directory).length === 0
          && identity(assertPlainRegistryPath(directory, 'directory')) === createdIdentity) rmdirSync(directory)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') markMaintenanceCleanupFailure()
      }
    }
    preserveError(error)
  }
}

/** 同卷原子发布后若验证失败，报告失败并保留真实状态，不假装回滚。 */
export function publishProtectedRegistry(homeDir: string, next: Record<string, unknown>, source: RegistrySourceReceipt, snapshot: ProtectedSnapshotReceipt): void {
  const directory = join(homeDir, '.mimir', REGISTRY_PRIVATE_DIRECTORY)
  const temp = join(directory, `.tmp-store-${randomUUID()}`)
  let prepared: FileReceipt | undefined, published = false
  try {
    if (dirname(snapshot.path) !== directory || snapshot.sourceSha256 !== source.sha256
      || identity(assertPlainRegistryPath(directory, 'directory')) !== snapshot.directoryIdentity) throw changed()
    verifyPrivatePath(directory, 'directory', snapshot.aclDeadline)
    verifyPrivatePath(snapshot.path, 'file', snapshot.aclDeadline)
    const saved = readBoundFile(snapshot.path)
    if (!equalStamp(saved.stamp, snapshot.stamp) || saved.sha256 !== source.sha256) throw changed()
    assertSource(homeDir, source)
    const bytes = Buffer.from(JSON.stringify(next, null, 2))
    if (bytes.length > 64 * 1024 * 1024) throw failed()
    prepared = writeCredentialFile(temp, bytes, snapshot.aclDeadline)
    assertSource(homeDir, source)
    if (identity(assertPlainRegistryPath(directory, 'directory')) !== snapshot.directoryIdentity
      || !equalStamp(readBoundFile(temp).stamp, prepared.stamp)) throw changed()
    renameSync(temp, sourcePath(homeDir)); published = true
    verifyPrivatePath(sourcePath(homeDir), 'file', snapshot.aclDeadline)
    const actual = readBoundFile(sourcePath(homeDir))
    if (fileIdentity(actual.stamp) !== fileIdentity(prepared.stamp) || actual.sha256 !== prepared.sha256) throw changed()
  } catch (error) {
    if (!published && prepared) unlinkOwned(temp, fileIdentity(prepared.stamp))
    if (published) throw new RestoreError(error instanceof RestoreError ? error.code : 'REGISTER_FAILED',
      '新空间登记已发布，但最终权限或内容复核未完成；原字节快照和恢复资料均保留，请重新检查维护记录。')
    preserveError(error)
  }
}
