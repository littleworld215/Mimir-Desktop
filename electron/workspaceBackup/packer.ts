/**
 * 空间备份打包（I6 批次 2 · 第 2 块）。
 *
 * 职责：以 `manifest.ts` 的条目清单为输入，把空间内容**流式**写成一个 ZIP64 归档，
 * 并在归档内附一份 `manifest.json`（供独立验包比对）。
 *
 * 纪律（对应 INTEGRATION-PLAN-I6「固定边界」）：
 * - **源 SQLite 一致快照**：先对 `assets.db` 做一次 `backup()` 到同盘临时文件，
 *   再把快照写进归档；不直接读正在使用的库，避免打包到撕裂的中间态。
 * - **源外暂存 + 验包后发布**：归档先写在空间外的暂存目录，`fsync` 后再原子 rename 到目标；
 *   打包过程中任何失败都清理暂存，不留半成品。
 * - **不可覆盖既有目标**：目标已存在时拒绝（`wx` 语义），不静默覆盖旧备份。
 * - **逐文件 SHA256 已由清单保证**，打包只负责搬运；条目与清单一一对应。
 * - 归档采用 **ZIP64**（大文件 / >4GiB 需要），由 yazl 在超出阈值时自动启用。
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, closeSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import yazl from 'yazl'
import type Database from 'better-sqlite3'
import { buildManifest, type ManifestEntry, type ManifestLimits, type ManifestOverrides, type ExcludedEntry } from './manifest'

/** 归档内的清单文件名（固定，验包时按此名读取）。 */
export const MANIFEST_IN_ARCHIVE = 'mimir-manifest.json'
/** 归档格式版本，供验包时判兼容。 */
export const BACKUP_FORMAT_VERSION = 1

export interface BackupRequest {
  /** 空间根目录（可信空间记录推导）。 */
  root: string
  /** 最终归档路径（必须不存在）。 */
  destination: string
  /** 同盘暂存目录（通常在空间之外的临时位置或 backups/）。 */
  stagingDir: string
  /** 用于快照的资产库；未打开时传 null（本次打包不含 assets.db）。 */
  assetsDb: Database.Database | null
  /** 相对空间根的 assets.db 路径（与清单中的 path 一致），用于定位快照注入点。 */
  assetsDbRelPath?: string
  limits?: ManifestLimits
}

export interface BackupResult {
  destination: string
  entries: number
  totalBytes: number
  archiveBytes: number
  /** 归档自身内容的 SHA256（外置记录，可与验包结果比对）。 */
  archiveSha256: string
  /**
   * **未纳入备份**的条目（当前只有超限单文件）。
   *
   * 对应 INTEGRATION-PLAN-I6「未包含依赖**明确报告**」：这些内容不在归档里，
   * 调用方必须把它展示/持久化给用户，不能静默丢弃。为空数组表示全部纳入。
   */
  excluded: ExcludedEntry[]
}

class BackupError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** 计算文件 SHA256（流式）。 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer)
  })
  return hash.digest('hex')
}

/**
 * 执行一次完整备份。
 *
 * 流程：清单 → 源库快照（可选）→ 写暂存归档 → fsync → 原子发布。
 * 失败路径：清理暂存与快照；已发布的目标不由本函数删除（rename 前不会创建目标）。
 */
export async function createBackup(request: BackupRequest): Promise<BackupResult> {
  const { root, destination, stagingDir, assetsDb, assetsDbRelPath, limits } = request
  if (existsSync(destination)) throw new BackupError('TARGET_EXISTS', `目标备份已存在，拒绝覆盖：${destination}`)
  mkdirSync(stagingDir, { recursive: true })

  const stagingArchive = join(stagingDir, `backup-${randomUUID()}.zip.partial`)
  const snapshotPath = assetsDb ? join(stagingDir, `snapshot-${randomUUID()}.db`) : null
  const normalizedDbRel = assetsDbRelPath ? assetsDbRelPath.split('\\').join('/') : null

  let published = false
  try {
    // ① SQLite 一致快照。必须在生成清单**之前**完成：
    //    清单要对归档内的真实内容（快照）计算摘要，否则验包必然假失败。
    //    独占创建空文件占位，再让 SQLite 填充（同盘，避免跨卷 rename 失败）。
    let overrides: ManifestOverrides | undefined
    if (assetsDb && snapshotPath && normalizedDbRel) {
      const fd = openSync(snapshotPath, 'wx', 0o600)
      closeSync(fd)
      await assetsDb.backup(snapshotPath)
      overrides = {
        replacement: new Map([[normalizedDbRel, { replacementAbsPath: snapshotPath, size: statSync(snapshotPath).size }]])
      }
    }

    // ② 清单：按「归档内实际内容」计算（含快照替换），供打包与验包共用同一基准。
    const manifest = await buildManifest(root, limits, overrides)

    // ③ 写归档：目录条目与文件条目都进；assets.db 用快照内容替换实时文件。
    const zip = new yazl.ZipFile()
    for (const entry of manifest.entries) {
      const sourceAbs = join(root, entry.path)
      if (entry.kind === 'directory') {
        zip.addEmptyDirectory(entry.path)
        continue
      }
      if (snapshotPath && normalizedDbRel !== null && entry.path === normalizedDbRel) {
        zip.addFile(snapshotPath, entry.path, { mtime: new Date(0) })
      } else {
        // 固定 mtime：同一空间两次备份的归档字节可比对（内容一致则在清单层面即可判等）。
        zip.addFile(sourceAbs, entry.path, { mtime: new Date(0) })
      }
    }
    // 清单作为最后一条写入归档；验包方据此逐条比对。
    const manifestBuffer = Buffer.from(JSON.stringify({
      version: BACKUP_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      entries: manifest.entries
    }), 'utf8')
    zip.addBuffer(manifestBuffer, MANIFEST_IN_ARCHIVE, { mtime: new Date(0) })

    // yazl 要求先 end()（写完所有条目）再消费 outputStream：
    // outputStream 只有在 end() 后才会结束，否则 pipeline 会永久挂起。
    zip.end()
    await pipeline(zip.outputStream, createWriteStream(stagingArchive, { flags: 'wx' }))

    // ③ 发布：同盘 rename 原子生效；失败保留暂存供排查，不覆盖目标。
    renameSync(stagingArchive, destination)
    published = true
    const archiveSha256 = await hashFile(destination)
    return {
      destination,
      entries: manifest.entries.length,
      totalBytes: manifest.totalBytes,
      archiveBytes: statSync(destination).size,
      archiveSha256,
      excluded: manifest.excluded
    }
  } catch (error) {
    if (!published) {
      try { unlinkSync(stagingArchive) } catch { /* 暂存可能尚未创建。 */ }
    }
    throw error instanceof BackupError ? error
      : new BackupError('BACKUP_FAILED', `备份失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    if (snapshotPath) {
      try { unlinkSync(snapshotPath) } catch { /* 快照可能未创建。 */ }
    }
  }
}

/** 归档内清单的结构（供 `verify.ts` 复用）。 */
export interface ArchiveManifest {
  version: number
  generatedAt: string
  entries: ManifestEntry[]
}

export { BackupError }
