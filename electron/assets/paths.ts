/**
 * 资产库目录布局与相对路径解析（**主进程专用**）。
 *
 * 布局（相对当前科研空间根，见 INTEGRATION-PLAN-I0-I1 §2.1）：
 * ```text
 * <spaceRoot>/.mimir/assets/
 *   assets.db
 *   files/<assetId>/<blobId>-<safeName>
 *   staging/
 *   backups/
 * ```
 *
 * 纪律：
 * - 数据库与版本文件路径**只由主进程生成**，不接受渲染层传入。
 * - 目录由可信空间记录推导（`spaceRoot()`），不按 renderer 路径索引。
 */

import { join, sep } from 'path'

/** 资产库在科研空间内的子目录名。 */
export const ASSETS_SUBDIR = '.mimir/assets'
export const ASSETS_DB_FILE = 'assets.db'
export const ASSETS_FILES_DIR = 'files'
export const ASSETS_STAGING_DIR = 'staging'
export const ASSETS_BACKUPS_DIR = 'backups'

export interface AssetsLayout {
  root: string
  dbPath: string
  filesDir: string
  stagingDir: string
  backupsDir: string
}

/**
 * 由**科研空间根目录**推导资产库布局。
 *
 * @param spaceRootDir 当前科研空间根（来自 `spaceRoot()`，已 resolve 的绝对路径）
 */
export function assetsLayout(spaceRootDir: string): AssetsLayout {
  const root = join(spaceRootDir, ASSETS_SUBDIR)
  return {
    root,
    dbPath: join(root, ASSETS_DB_FILE),
    filesDir: join(root, ASSETS_FILES_DIR),
    stagingDir: join(root, ASSETS_STAGING_DIR),
    backupsDir: join(root, ASSETS_BACKUPS_DIR)
  }
}

/**
 * 清洗文件名，得到可安全用于磁盘的文件名片段（去掉路径分隔符与控制字符）。
 * 只影响磁盘存储名；显示名仍由 DB 的 `file_name` 保留。
 */
export function safeFileName(input: string): string {
  const base = input.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const cleaned = base === '' || base === '.' || base === '..' ? 'file' : base
  // 限制长度，保留扩展名
  if (cleaned.length <= 120) return cleaned
  const dot = cleaned.lastIndexOf('.')
  if (dot > 0 && cleaned.length - dot <= 16) {
    return `${cleaned.slice(0, 100)}${cleaned.slice(dot)}`
  }
  return cleaned.slice(0, 120)
}

/**
 * 生成某资产某版本 blob 的**相对**路径（相对资产库根）：
 * `files/<assetId>/<blobId>-<safeName>`。
 *
 * blobId 由主进程生成（时间戳 + 随机后缀），保证「同名文件再次上传也是独立 blob」。
 */
export function versionBlobRelPath(assetId: number, blobId: string, fileName: string): string {
  return `${ASSETS_FILES_DIR}/${assetId}/${blobId}-${safeFileName(fileName)}`
}

/** 生成一个唯一 blobId（不引入额外依赖）。 */
export function newBlobId(now: Date = new Date()): string {
  const ts = now.getTime().toString(36)
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${ts}-${rnd}`
}

/**
 * 把 DB 里存的**相对资产库根**路径（形如 `files/<assetId>/<blob>-<name>`）解析为绝对路径，
 * 并断言结果仍在 `files/` 之下（防 DB 被篡改后越界读取）。
 *
 * @throws 越界或含 `..` 时抛错
 */
export function resolveWithinFiles(layout: AssetsLayout, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized === '' || normalized.split('/').some((seg) => seg === '' || seg === '..')) {
    throw new Error('非法的资产文件相对路径')
  }
  const abs = join(layout.root, normalized)
  const prefix = layout.filesDir.endsWith(sep) ? layout.filesDir : `${layout.filesDir}${sep}`
  if (abs !== layout.filesDir && !abs.startsWith(prefix)) {
    throw new Error('非法的资产文件相对路径')
  }
  return abs
}
