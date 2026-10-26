/** 归档读取侧统一限额和元数据校验；不依赖打包过程或渲染层提供的声明。 */
import type yauzl from 'yauzl'
import { validateArchivePaths } from './archivePaths'
import { BACKUP_FORMAT_VERSION, MANIFEST_IN_ARCHIVE, type ArchiveManifest } from './archiveFormat'
import type { ManifestEntry } from './manifest'
import { validateBackupMetadata } from './archiveMetadata'

export interface ArchiveReadLimits {
  maxEntries: number
  maxManifestBytes: number
  maxTotalBytes: number
}
export const DEFAULT_ARCHIVE_READ_LIMITS: Readonly<ArchiveReadLimits> = Object.freeze({
  maxEntries: 100_000,
  maxManifestBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024 * 1024
})
export type ArchiveLimitsInput = number | Partial<ArchiveReadLimits>
type ArchiveErrorCode = 'OPEN_FAILED' | 'READ_FAILED' | 'ENTRY_LIMIT' | 'MANIFEST_LIMIT' | 'TOTAL_LIMIT'
  | 'LIMIT_INVALID' | 'MANIFEST_INVALID' | 'MANIFEST_MISSING' | 'VERSION_UNSUPPORTED' | 'UNSAFE_ENTRY'
  | 'DUPLICATE_ENTRY' | 'MISSING_ENTRY' | 'EXTRA_ENTRY' | 'SIZE_MISMATCH' | 'DIGEST_MISMATCH' | 'PATH_ESCAPE'

export class VerifyError extends Error {
  constructor(readonly code: ArchiveErrorCode, message: string) { super(message) }
}

/** 内部可收紧预算；不允许调用者提升生产上限。旧数字参数仍代表条目上限。 */
export function resolveArchiveLimits(input: ArchiveLimitsInput = {}): ArchiveReadLimits {
  const limits = { ...DEFAULT_ARCHIVE_READ_LIMITS, ...(typeof input === 'number' ? { maxEntries: input } : input) }
  for (const key of Object.keys(limits) as (keyof ArchiveReadLimits)[]) {
    const value = limits[key]
    if (!Number.isSafeInteger(value) || value < (key === 'maxTotalBytes' ? 0 : 1)
      || value > DEFAULT_ARCHIVE_READ_LIMITS[key]) throw new VerifyError('LIMIT_INVALID', `归档读取限额无效：${key}`)
  }
  return limits
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** 只收窄类型，不剥离未知业务键；旧格式1缺sourceRoot仍合法。 */
export function parseArchiveManifest(buffer: Buffer, limits: ArchiveReadLimits): ArchiveManifest {
  let value: unknown
  try { value = JSON.parse(buffer.toString('utf8')) } catch { throw new VerifyError('MANIFEST_INVALID', '归档清单不是合法 JSON') }
  if (!record(value) || !Number.isSafeInteger(value.version)) throw new VerifyError('MANIFEST_INVALID', '归档清单根或版本类型无效')
  if (value.version !== BACKUP_FORMAT_VERSION) throw new VerifyError('VERSION_UNSUPPORTED', `归档格式版本 ${value.version} 不受支持（期望 ${BACKUP_FORMAT_VERSION}）`)
  if (typeof value.generatedAt !== 'string' || (value.sourceRoot !== undefined && (typeof value.sourceRoot !== 'string' || value.sourceRoot.includes('\0')))
    || (value.sourceSpaceId !== undefined && (typeof value.sourceSpaceId !== 'string' || !value.sourceSpaceId || value.sourceSpaceId.trim() !== value.sourceSpaceId
      || value.sourceSpaceId.length > 200 || /[\u0000-\u001f\u007f]/.test(value.sourceSpaceId)))
    || !Array.isArray(value.entries)) throw new VerifyError('MANIFEST_INVALID', '归档清单元数据类型无效')
  if (value.entries.length > limits.maxEntries) throw new VerifyError('ENTRY_LIMIT', '清单条目数超过上限')
  let total = 0
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.path !== 'string' || (entry.kind !== 'file' && entry.kind !== 'directory')
      || !validSize(entry.size) || typeof entry.sha256 !== 'string'
      || (entry.kind === 'file' ? !/^[a-f0-9]{64}$/.test(entry.sha256) : entry.size !== 0 || entry.sha256 !== '')) {
      throw new VerifyError('MANIFEST_INVALID', '清单条目的路径、类型、字节数或摘要无效')
    }
    if (entry.path.toUpperCase() === MANIFEST_IN_ARCHIVE.toUpperCase()) throw new VerifyError('MANIFEST_INVALID', '清单不能将自身声明为业务文件')
    if (entry.size > limits.maxTotalBytes - total) throw new VerifyError('TOTAL_LIMIT', '清单声明的展开内容超过上限')
    total += entry.size
  }
  const manifest = value as unknown as ArchiveManifest
  try { validateArchivePaths(manifest.entries, limits.maxEntries) } catch (error) {
    throw new VerifyError('UNSAFE_ENTRY', `清单路径无效：${error instanceof Error ? error.message : '未知错误'}`)
  }
  if (Object.hasOwn(value, 'metadata')) {
    try { manifest.metadata = validateBackupMetadata(value.metadata, manifest.entries) } catch (error) {
      throw new VerifyError((error as { code?: string }).code === 'VERSION_UNSUPPORTED' ? 'VERSION_UNSUPPORTED' : 'MANIFEST_INVALID', '归档范围说明无效或不受支持。')
    }
  }
  return manifest
}

/** 每一遍中央目录都重新计数，不能只相信ZIP头或上一遍观察。 */
export class ArchiveInventory {
  readonly entries = new Map<string, ManifestEntry>()
  totalBytes = 0
  constructor(readonly limits: ArchiveReadLimits) {}

  accept(entry: yauzl.Entry): ManifestEntry {
    if (this.entries.size >= this.limits.maxEntries) throw new VerifyError('ENTRY_LIMIT', '归档条目数超过上限')
    const name = entry.fileName.split('\\').join('/')
    const kind = name.endsWith('/') ? 'directory' : 'file'
    const path = kind === 'directory' ? name.slice(0, -1) : name
    if (this.entries.has(path)) throw new VerifyError('DUPLICATE_ENTRY', `归档含重复条目：${path}`)
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000
    if (!validSize(entry.uncompressedSize) || !validSize(entry.compressedSize) || (entry.generalPurposeBitFlag & 1) !== 0
      || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
      || (mode !== 0 && mode !== (kind === 'file' ? 0x8000 : 0x4000))
      || (kind === 'file' && (entry.externalFileAttributes & 0x10) !== 0)
      || (kind === 'directory' && entry.uncompressedSize !== 0)
      || (path === MANIFEST_IN_ARCHIVE && kind !== 'file')) throw new VerifyError('UNSAFE_ENTRY', `归档条目元数据无效：${path}`)
    const item: ManifestEntry = { path, kind, size: entry.uncompressedSize, sha256: '' }
    try { validateArchivePaths([item]) } catch (error) { throw new VerifyError('UNSAFE_ENTRY', `归档路径无效：${error instanceof Error ? error.message : '未知错误'}`) }
    if (path === MANIFEST_IN_ARCHIVE) {
      if (item.size > this.limits.maxManifestBytes) throw new VerifyError('MANIFEST_LIMIT', '归档清单字节数超过上限')
    } else {
      if (item.size > this.limits.maxTotalBytes - this.totalBytes) throw new VerifyError('TOTAL_LIMIT', '归档声明的展开内容超过上限')
      this.totalBytes += item.size
    }
    this.entries.set(path, item)
    return item
  }

  match(manifest: ArchiveManifest): void {
    if (!this.entries.has(MANIFEST_IN_ARCHIVE)) throw new VerifyError('MANIFEST_MISSING', `归档缺少清单 ${MANIFEST_IN_ARCHIVE}`)
    try { validateArchivePaths([...this.entries.values()], this.limits.maxEntries) } catch (error) {
      throw new VerifyError('UNSAFE_ENTRY', `归档路径集合无效：${error instanceof Error ? error.message : '未知错误'}`)
    }
    const expected = new Map(manifest.entries.map(entry => [entry.path, entry]))
    for (const item of manifest.entries) {
      const actual = this.entries.get(item.path)
      if (!actual) throw new VerifyError('MISSING_ENTRY', `归档缺少清单声明的条目：${item.path}`)
      if (actual.kind !== item.kind) throw new VerifyError('UNSAFE_ENTRY', `归档条目类型与清单不符：${item.path}`)
      if (actual.size !== item.size) throw new VerifyError('SIZE_MISMATCH', `条目字节数不符：${item.path}（归档 ${actual.size} / 清单 ${item.size}）`)
    }
    for (const path of this.entries.keys()) {
      if (path !== MANIFEST_IN_ARCHIVE && !expected.has(path)) throw new VerifyError('EXTRA_ENTRY', `归档含清单未声明的条目：${path}`)
    }
  }
}

/** 在内容交给哈希/磁盘前扣预算；不使用归档自报数值替代实际流量。 */
export class ArchiveByteBudget {
  total = 0
  constructor(readonly maximum: number, readonly code: 'MANIFEST_LIMIT' | 'TOTAL_LIMIT') {}
  take(bytes: number): void {
    if (bytes > this.maximum - this.total) throw new VerifyError(this.code, this.code === 'MANIFEST_LIMIT' ? '清单实际展开超过上限' : '业务内容实际展开超过上限')
    this.total += bytes
  }
}
