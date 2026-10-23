import type { ManifestEntry } from './manifest'

/** 纯格式定义，使独立验包与打包双向复用时不形成运行时循环。 */
export const MANIFEST_IN_ARCHIVE = 'mimir-manifest.json'
export const BACKUP_FORMAT_VERSION = 1
export interface ArchiveManifest {
  version: number
  generatedAt: string
  /** 早期格式1可能缺失；恢复不能据此猜测绝对路径。 */
  sourceRoot?: string
  entries: ManifestEntry[]
}
