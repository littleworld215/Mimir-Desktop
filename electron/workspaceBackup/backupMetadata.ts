/** 只观察来源空间的已知结构字段；外部目标从不打开、stat或递归。 */
import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { BackupMetadata, BackupProducer } from '../../shared/workspaceBackupMetadata'
import type { ManifestEntry, ExcludedEntry } from './manifest'
import type { AssetsIntegrityOptions } from './assetsIntegrity'
import { resolveAssetsNativeBinding } from '../assets/nativeBinding'
import { collectPathReferences } from './structuredPaths'
import { isAbsolutePathLike, matchRootPrefix } from './remapRules'
import { validateBackupMetadata } from './archiveMetadata'
import { maintenanceCheckpoint, markMaintenanceCleanupFailure } from './maintenanceTask'

export interface BackupMetadataInput {
  root: string
  entries: readonly ManifestEntry[]
  excluded: readonly ExcludedEntry[]
  maxFileBytes: number
  producer?: BackupProducer
  snapshot?: { path: string; relativePath: string }
  assetsIntegrityOptions?: AssetsIntegrityOptions
}

/** 读取实际快照的版本，关闭失败不得伪造成功。 */
export function readSnapshotUserVersion(path: string, options: AssetsIntegrityOptions = {}): number {
  const nativeBinding = options.nativeBinding ?? resolveAssetsNativeBinding({ ...options, isPackaged: options.isPackaged ?? false }).nativeBinding
  const db = new Database(path, { readonly: true, fileMustExist: true, nativeBinding })
  try {
    const value = db.pragma('user_version', { simple: true })
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('快照数据库版本无效。')
    return Number(value)
  } finally {
    try { db.close() } catch (error) { markMaintenanceCleanupFailure(); throw error }
  }
}

const MAX_STORE_BYTES = 64 * 1024 * 1024
const representable = (v: string, limit: number) => v.length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v)
function readSourceStore(root: string): { store?: Record<string, unknown>; reason?: 'missing-store' | 'invalid-store' | 'oversize-store' } {
  let fd: number
  try { fd = openSync(join(root, '.mimir', 'store.json'), 'r') } catch (error) {
    return { reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-store' : 'invalid-store' }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { reason: 'invalid-store' }
    if (stat.size > MAX_STORE_BYTES) return { reason: 'oversize-store' }
    const bytes = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null)
      if (n === 0) break
      count += n
    }
    if (count > MAX_STORE_BYTES || count !== stat.size) return { reason: 'invalid-store' }
    const value: unknown = JSON.parse(bytes.subarray(0, count).toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { store: value as Record<string, unknown> } : { reason: 'invalid-store' }
  } catch { return { reason: 'invalid-store' } } finally {
    try { closeSync(fd) } catch (error) { markMaintenanceCleanupFailure(); throw error }
  }
}

/** 生成有界声明，最后再用独立读取侧校验约束。 */
export async function buildBackupMetadata(input: BackupMetadataInput): Promise<BackupMetadata> {
  await maintenanceCheckpoint()
  const dbEntry = input.entries.find(e => e.kind === 'file' && e.path.toLowerCase() === '.mimir/assets/assets.db')
  const snapshotEntry = input.snapshot && input.entries.find(e => e.kind === 'file' && e.path === input.snapshot!.relativePath)
  const database: BackupMetadata['database'] = snapshotEntry && input.snapshot
    ? { state: 'present', path: snapshotEntry.path, userVersion: readSnapshotUserVersion(input.snapshot.path, input.assetsIntegrityOptions) }
    : dbEntry ? { state: 'unknown', path: dbEntry.path } : { state: 'absent' }
  const source = readSourceStore(input.root)
  const external: BackupMetadata['external'] = {
    coverage: source.reason ? 'unknown' : 'known-structured-fields',
    ...(source.reason ? { reason: source.reason } : {}), unresolved: 0, references: []
  }
  if (source.store) {
    for (const ref of collectPathReferences(source.store, { includeNonString: true })) {
      await maintenanceCheckpoint()
      const target: unknown = Reflect.get(ref.container, ref.field)
      if (target === '') continue
      if (typeof target !== 'string' || !representable(target, 32768) || !representable(ref.locator, 2048)
        || !representable(ref.storeKey, 2048) || !representable(ref.field, 2048)
        || !isAbsolutePathLike(target) || /^[/\\]{2}/.test(target)) {
        external.coverage = 'unknown'; external.reason = 'ambiguous-reference'; external.unresolved++
        continue
      }
      if (matchRootPrefix(target, input.root).matched) continue
      if (external.references.length + input.excluded.length >= 100_000) throw Object.assign(new Error('范围说明条目超过上限。'), { code: 'MANIFEST_LIMIT' })
      external.references.push({ storeKey: ref.storeKey, locator: ref.locator, field: ref.field, kind: ref.kind, target, status: 'not-included-unchecked' })
    }
  }
  const platform = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'unknown'
  return validateBackupMetadata({ version: 1,
    producer: input.producer ?? { application: 'Mimir-Desktop', version: null, platform }, database,
    maxFileBytes: input.maxFileBytes, exclusionPolicyVersion: 1, excluded: input.excluded.map(e => ({ ...e })), external
  }, input.entries)
}
