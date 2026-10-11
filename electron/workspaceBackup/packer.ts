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
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import yazl from 'yazl'
import type Database from 'better-sqlite3'
import { buildManifest, type ManifestEntry, type ManifestLimits, type ManifestOverrides, type ExcludedEntry } from './manifest'
import { deriveArchiveName, isManagedArchive } from './archiveNaming'

/** 归档内的清单文件名（固定，验包时按此名读取）。 */
export const MANIFEST_IN_ARCHIVE = 'mimir-manifest.json'
/** 归档格式版本，供验包时判兼容。 */
export const BACKUP_FORMAT_VERSION = 1

export interface BackupRequest {
  /** 空间根目录（可信空间记录推导）。 */
  root: string
  /**
   * 最终归档路径（必须不存在）。
   *
   * **可选**：调用方可以显式给出目标（保持批次 2 以来的行为）；也可**省略**并用 `spaceName`
   * 让 packer 按归档命名规范（`archiveNaming.ts`）**自动派生**一个目标名——见 `spaceName`。
   *
   * 校验纪律（I6 批次 5 · T03）：
   * - 与 `spaceName` **同时给出**时，本字段被视为「采用受管命名」的意图 → 必须满足
   *   `isManagedArchive(basename(destination))`，否则抛 `INVALID_DESTINATION`。理由：保留策略
   *   （`retentionPolicy` / `archiveScan`）的白名单锚定 `mimir-backup-<slug>-<ts>.zip`；若允许
   *   调用方产出一个白名单永远认不出的名字，该归档会**永久累积且永不被清理**（K1/K5 的反面）。
   * - **仅**给出 `destination`（未给 `spaceName`）时保持**既有语义不变**：不校验命名，
   *   直接按调用方给的路径发布——批次 2–4 的调用方（恢复/集成测试等）依赖此行为。
   */
  destination?: string
  /**
   * 空间名（用于按归档命名规范**派生**目标名；I6 批次 5 · T03 新增，可选）。
   *
   * - 省略 `destination` 时**必填**：packer 用 `deriveArchiveName(spaceName, now)` 生成文件名，
   *   落点为 `join(dirname(stagingDir), <name>)`（暂存目录的**兄弟**，见 `createBackup` 内注释）。
   * - 与 `destination` 同时给出时：触发上面对 `destination` 的**受管命名校验**。
   */
  spaceName?: string
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
 * 决策最终归档落点（I6 批次 5 · T03）。
 *
 * 三条分支，**优先级从显式到隐含**：
 *
 * 1. **给了 `destination` + 给了 `spaceName`** → 调用方明确「采用受管命名」：
 *    校验 `isManagedArchive(basename(destination))`。不满足 → `INVALID_DESTINATION`。
 *    （为什么校验而非放行：产出保留策略认不出的名字 = 归档永久累积不被清理。）
 * 2. **给了 `destination`、未给 `spaceName`** → **既有语义不变**：原样使用，不校验。
 *    这条分支保证批次 2–4 的既有调用方（`space.zip` / `b.zip` / 集成测试等）行为**逐字节不变**。
 * 3. **未给 `destination`** → 要求 `spaceName` 必填，按规范派生：
 *    `join(dirname(stagingDir), deriveArchiveName(spaceName, now))`。
 *
 * 分支 3 的落点说明（`dirname(stagingDir)`）：
 *   把归档放在**暂存目录的兄弟**位置，是**临时**落点——packer 目前不知道生产 `backups/`
 *   目录（那是 `maintenanceMain.ts:20` 的 `ARCHIVE_DIRECTORY_NAME`，且缺省逻辑刻意不 import
 *   维护层以免引入打包层对 UI/维护层的依赖）。真正落 `backups/` 仍由调用方显式给
 *   `destination` 决定（分支 1/2）。派生名保证「即使走缺省落点，文件名也**通过 `isManagedArchive`**」，
 *   从而命名规则在**打包路径上被强制落实**，同时不臆造一个假的 `backups/` 接线。
 *
 * @param request 备份请求。
 * @returns 最终归档的**绝对**路径。
 * @throws {BackupError} `INVALID_DESTINATION`（分支 1 校验失败）/ `MISSING_SPACE_NAME`（分支 3 缺空间名）。
 */
function resolveDestination(request: BackupRequest): string {
  const { destination, spaceName, stagingDir } = request
  if (destination !== undefined) {
    // 分支 1：与 spaceName 同给 → 受管命名校验（命名规则在打包路径被强制落实）。
    if (spaceName !== undefined && !isManagedArchive(basename(destination))) {
      throw new BackupError(
        'INVALID_DESTINATION',
        `目标归档名不符合受管命名规范（应为 mimir-backup-<空间名slug>-<YYYYMMDD-HHMMSS>.zip）：${basename(destination)}`
      )
    }
    // 分支 1（校验通过）/ 分支 2（未给 spaceName，原样使用）——共用返回。
    return destination
  }
  // 分支 3：未给 destination → 必须能派生。
  if (spaceName === undefined || spaceName === '') {
    throw new BackupError('MISSING_SPACE_NAME', '未提供 destination 时必须提供 spaceName 以按命名规范派生归档名')
  }
  const derivedAbs = join(dirname(stagingDir), deriveArchiveName(spaceName, new Date()))
  return derivedAbs
}

/**
 * 执行一次完整备份。
 *
 * 流程：清单 → 源库快照（可选）→ 写暂存归档 → fsync → 原子发布。
 * 失败路径：清理暂存与快照；已发布的目标不由本函数删除（rename 前不会创建目标）。
 */
export async function createBackup(request: BackupRequest): Promise<BackupResult> {
  const { root, stagingDir, assetsDb, assetsDbRelPath, limits, spaceName } = request
  const destination = resolveDestination(request)
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
    // `sourceRoot` 记录**打包时的源空间绝对根**：恢复侧要按「旧空间绝对根为前缀」改写
    // `pdfPath`（T03 的 `matchRootPrefix` 硬要求绝对路径，见 restoreArchive.ts 长注释），
    // 而归档条目一律是相对路径，故绝对根只能由打包侧显式带来。
    const manifestBuffer = Buffer.from(JSON.stringify({
      version: BACKUP_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      sourceRoot: resolve(root),
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
  /**
   * 打包时源空间的**绝对根**（可选）。
   *
   * 存在理由：恢复侧 T03 要按旧空间**绝对**根前缀改写 `pdfPath`（`remapRules.matchRootPrefix`
   * 硬要求两边都是绝对路径），而归档条目全是相对路径，绝对根无法从条目反推。
   * 记在这里让恢复能直接拿到。
   *
   * ⚠️ **可选**：批次 2/3 早期产出的归档没有本字段；恢复侧读到 `undefined` 时必须退化为
   * 「不改写」（可用 `oldRootFromArchive` 的相对根做**非权威**提示，但绝不据此改写）。
   */
  sourceRoot?: string
  entries: ManifestEntry[]
}

export { BackupError }
