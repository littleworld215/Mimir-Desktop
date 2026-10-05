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

import { basename, dirname, join, sep } from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'

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
 * 清洗文件名，得到可安全用于磁盘的文件名片段。
 *
 * Windows 上 `< > : " / \ | ? *` 及控制字符在文件名中非法（写入失败或产生路径歧义），
 * 结尾的点与空格同样非法（会被静默截断或写入失败）。这里统一清洗：
 * - `< > : " / \ | ? *` → 下划线；
 * - 控制字符（`\u0000-\u001f`、`\u007f`）→ 移除（不可见，替换成下划线反而制造噪音）；
 * - 去掉结尾的点与空格，并 trim 首尾空白；
 * - 清洗后为空 / `.` / `..` → `file`；
 * - 保留长度上限（≤120，尽量保留扩展名）。
 *
 * 只影响磁盘存储名；**显示名**仍由 DB 的 `file_name` 保留（原始名）。
 */
export function safeFileName(input: string): string {
  const base = input
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
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
 * 解析「最近已存在祖先」的真实路径：对尚不存在的目标（写入前）取最近已存在祖先的
 * `realpathSync`，再把不存在的尾部拼回。用于在目标尚不存在时仍能做 realpath 级校验。
 */
function realpathOrNearest(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(current)
      // 到达文件系统根仍无法 realpath：退回原路径（不再上溯）。
      if (parent === current) return tail.length === 0 ? current : join(current, ...tail)
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * 把 DB 里存的**相对资产库根**路径（形如 `files/<assetId>/<blob>-<name>`）解析为绝对路径，
 * 并断言结果仍在**可信 `files` 根**之下。
 *
 * 与旧实现（仅字符串前缀检查）的关键差别：旧实现无法识别 `files/` 内的 junction / symlink
 * 指向库外的情况——字符串前缀看起来仍在 files 下，实际 realpath 已越界。这里改为：
 * 1. 先做字符串层面的拒绝（绝对路径 / 盘符 / `..` / 空段 / `.`）；
 * 2. 再对**可信 files 根**与**解析后的目标**分别取 realpath（目标不存在时取最近已存在祖先），
 *    断言真实目标仍位于真实 files 根之下（且不是 files 根目录本身）。
 *
 * 必须拒绝：绝对路径、含 `..`、目录本身、以及 realpath 后越出 files 根的 junction/symlink。
 *
 * @throws 越界 / 非法路径时抛错
 */
export function resolveWithinFiles(layout: AssetsLayout, relPath: string): string {
  if (typeof relPath !== 'string') throw new Error('非法的资产文件相对路径')
  const normalized = relPath.replace(/\\/g, '/')
  // 绝对路径（POSIX 前导斜杠 / Windows 盘符 / UNC）一律拒绝。
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('非法的资产文件相对路径')
  }
  const segments = normalized.split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error('非法的资产文件相对路径')
  }
  const abs = join(layout.root, normalized)

  // realpath 级校验：字符串前缀不足以防御 files 内的 junction/symlink 越界。
  const filesReal = realpathOrNearest(layout.filesDir)
  const absReal = realpathOrNearest(abs)
  const prefix = filesReal.endsWith(sep) ? filesReal : `${filesReal}${sep}`
  // 必须严格位于 files 根**之下**（等于 files 根 = 目录本身，同样拒绝）。
  if (absReal === filesReal || !absReal.startsWith(prefix)) {
    throw new Error('非法的资产文件相对路径')
  }
  // 目标已存在且是目录：拒绝（本函数只解析到文件）。
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    throw new Error('非法的资产文件相对路径')
  }
  return abs
}
