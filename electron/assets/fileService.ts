/**
 * 资产文件版本服务（I1-04）。
 *
 * 覆盖 `shared/assetsContracts.ts` 的 6 个方法：
 * - importFile   把任意文件作为**新版本**导入到文件型资产（不可变 blob 落到托管 files/ 目录）
 * - saveFile     把某版本（文件或正文）落盘到渲染层选定的目标路径
 * - listVersions 分页版本历史
 * - getVersion   取单个版本（含正文 / source）
 * - diffVersions 文本版本逐行 diff；文件版本返回 kind='file'（无逐行 diff）
 * - rollbackVersion 以旧版本为正文 / 复用旧 blob 生成新版本（append-only 语义）
 *
 * 设计纪律（与 I0/I1 其它服务一致）：
 * - 唯一写入入口是 `ctx.write`；会话在事务结束后失效，跨 await 持有即失效。
 * - 文件 I/O 一律同步（`copyFileSync` / `writeFileSync`），不破坏事务同步约束。
 * - 版本 append-only：先校验 revision/version，再落盘 blob，最后写 DB；blob 落盘失败则清理孤儿文件。
 * - 渲染层传入的路径在 IPC 层经 `assertRendererPath` 校验，服务层只接收已可信的绝对路径。
 */

import { basename, dirname, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type {
  AssetDetail,
  AssetVersion,
  VersionDiff,
  VersionDiffLine,
  VersionPage,
  WriteCondition
} from '../../shared/assetsContracts'
import { ASSET_FILE_MAX_BYTES } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'
import { assertFileBytes } from './validation'
import { selectAsset, detail, appendVersion, type AssetRow } from './assetRepository'
import { newBlobId, versionBlobRelPath, resolveWithinFiles } from './paths'
import {
  selectVersion,
  countVersions,
  listVersionRows,
  versionSummary,
  toAssetVersion,
  type VersionRow
} from './versionRepository'

// ── 参数校验基元 ──────────────────────────────────────────────────────────
function object(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AssetsStoreError('BAD_REQUEST', `${label}必须是对象。`)
  }
  return input as Record<string, unknown>
}
function positive(input: unknown, label = 'id'): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) {
    throw new AssetsStoreError('BAD_REQUEST', `${label}非法。`)
  }
  return input
}
/** 解析条件写；expectedRevision 必填，expectedCurrentVersionId 可选（显式 null 视为不校验）。 */
function parseCondition(c: unknown): {
  expectedRevision: number
  hasVersion: boolean
  expectedCurrentVersionId: number | null | undefined
} {
  const o = object(c, '条件')
  if (Object.keys(o).some(k => !['expectedRevision', 'expectedCurrentVersionId'].includes(k))) {
    throw new AssetsStoreError('BAD_REQUEST', '条件参数非法。')
  }
  const expectedRevision = positive(o.expectedRevision, 'expectedRevision')
  const hasVersion = Object.hasOwn(o, 'expectedCurrentVersionId')
  let expectedCurrentVersionId: number | null | undefined
  if (hasVersion) {
    if (o.expectedCurrentVersionId === null) expectedCurrentVersionId = null
    else if (o.expectedCurrentVersionId !== undefined) expectedCurrentVersionId = positive(o.expectedCurrentVersionId, 'expectedCurrentVersionId')
  }
  return { expectedRevision, hasVersion, expectedCurrentVersionId }
}
/** 分页参数：默认 1 / 50，上限 200，仅接受正整数 safe integer。 */
function parsePaging(page: unknown, pageSize: unknown): { page: number; pageSize: number } {
  const p = page === undefined ? 1 : positive(page, 'page')
  const ps = pageSize === undefined ? 50 : positive(pageSize, 'pageSize')
  if (ps > 200) throw new AssetsStoreError('BAD_REQUEST', '每页条数超过上限。')
  return { page: p, pageSize: ps }
}

// ── importFile ────────────────────────────────────────────────────────────
/** 把源文件作为新版本导入文件型资产；blob 落到托管 files/<assetId>/<blob>-<name>。 */
export function importFile(
  ctx: AssetsContext,
  assetId: number,
  condition: unknown,
  sourcePath: string,
  changelog?: string
): AssetDetail {
  const id = positive(assetId)
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new AssetsStoreError('BAD_REQUEST', 'sourcePath 必须是非空字符串。')
  }
  const c = parseCondition(condition)
  const log = typeof changelog === 'string' ? changelog : ''
  const now = new Date().toISOString()

  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    if (row.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
    if (row.storage_type !== 'file') throw new AssetsStoreError('BAD_REQUEST', '仅文件型资产可导入文件。')
    if (row.revision !== c.expectedRevision) {
      throw new AssetsStoreError('REVISION_CONFLICT', '资产已更新。', { currentRevision: row.revision })
    }
    if (c.hasVersion && c.expectedCurrentVersionId !== row.current_version_id) {
      throw new AssetsStoreError('VERSION_CONFLICT', '当前版本已改变。', { currentVersionId: row.current_version_id })
    }

    // 先校验源文件，再决定落盘目标——校验失败不产生任何副作用。
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(sourcePath)
    } catch {
      throw new AssetsStoreError('FILE_UNAVAILABLE', '源文件不可读或不存在。')
    }
    if (!stat.isFile()) throw new AssetsStoreError('BAD_REQUEST', '源路径不是普通文件。')
    assertFileBytes(stat.size)

    const fileName = basename(sourcePath)
    const relPath = versionBlobRelPath(id, newBlobId(), fileName)
    const abs = resolveWithinFiles(ctx.layout, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(sourcePath, abs)

    // blob 已落盘；DB 写入若失败则清理孤儿 blob（事务回滚只管 DB）。
    try {
      const next = (s.get<{ n: number }>('SELECT coalesce(max(version),0) n FROM asset_version WHERE asset_id=?', id)?.n ?? 0) + 1
      s.run(
        'INSERT INTO asset_version(asset_id,version,content,changelog,source_json,file_path,file_name,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, next, '', log, row.source_json, relPath, fileName, now
      )
      const vid = s.get<{ id: number }>('SELECT last_insert_rowid() id')?.id as number
      s.run('UPDATE asset SET current_version_id=?, revision=revision+1, updated_at=? WHERE id=?', vid, now, id)
      return detail(s, selectAsset(s, id) as AssetRow, ctx.layout)
    } catch (error) {
      try { unlinkSync(abs) } catch { /* 孤儿 blob 清理尽力而为 */ }
      throw error
    }
  })
}

// ── saveFile ─────────────────────────────────────────────────────────────
/** 把某版本（文件 blob 或正文）落盘到目标路径。versionId 缺省取当前版本。 */
export function saveFile(
  ctx: AssetsContext,
  assetId: number,
  versionId: number | undefined,
  destinationPath: string
): { saved: true } {
  const id = positive(assetId)
  if (typeof destinationPath !== 'string' || destinationPath.trim() === '') {
    throw new AssetsStoreError('BAD_REQUEST', 'destinationPath 必须是非空字符串。')
  }
  const dest = resolve(destinationPath)

  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const vid = versionId == null ? row.current_version_id : positive(versionId, 'versionId')
    if (vid === null) throw new AssetsStoreError('NOT_FOUND', '该资产尚无版本。')
    const v = selectVersion(s, id, vid)
    if (v === undefined) throw new AssetsStoreError('NOT_FOUND', '版本不存在。')

    mkdirSync(dirname(dest), { recursive: true })
    if (v.file_path !== null) {
      const abs = resolveWithinFiles(ctx.layout, v.file_path)
      if (!existsSync(abs)) throw new AssetsStoreError('FILE_UNAVAILABLE', '版本文件已不存在。')
      copyFileSync(abs, dest)
    } else {
      writeFileSync(dest, v.content)
    }
    return { saved: true }
  })
}

// ── listVersions ──────────────────────────────────────────────────────────
export function listVersions(ctx: AssetsContext, assetId: number, page?: unknown, pageSize?: unknown): VersionPage {
  const id = positive(assetId)
  const { page: p, pageSize: ps } = parsePaging(page, pageSize)
  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const total = countVersions(s, id)
    const rows = listVersionRows(s, id, p, ps)
    return { items: rows.map(versionSummary), total, page: p, pageSize: ps }
  })
}

// ── getVersion ────────────────────────────────────────────────────────────
export function getVersion(ctx: AssetsContext, assetId: number, versionId: number): { version: AssetVersion } {
  const id = positive(assetId)
  const vid = positive(versionId, 'versionId')
  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const v = selectVersion(s, id, vid)
    if (v === undefined) throw new AssetsStoreError('NOT_FOUND', '版本不存在。')
    return { version: toAssetVersion(v) }
  })
}

// ── diffVersions ──────────────────────────────────────────────────────────
export function diffVersions(
  ctx: AssetsContext,
  assetId: number,
  fromVersionId: number,
  toVersionId: number
): { diff: VersionDiff } {
  const id = positive(assetId)
  const f = positive(fromVersionId, 'fromVersionId')
  const t = positive(toVersionId, 'toVersionId')
  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const a = selectVersion(s, id, f)
    if (a === undefined) throw new AssetsStoreError('NOT_FOUND', '源版本不存在。')
    const b = selectVersion(s, id, t)
    if (b === undefined) throw new AssetsStoreError('NOT_FOUND', '目标版本不存在。')
    // 任一侧是文件版本 → 无逐行 diff（二进制无法文本比对）。
    if (a.file_path !== null || b.file_path !== null) {
      return { diff: { kind: 'file', fromVersion: a.version, toVersion: b.version, lines: [] } }
    }
    return {
      diff: {
        kind: 'text',
        fromVersion: a.version,
        toVersion: b.version,
        lines: diffLines(a.content.split('\n'), b.content.split('\n'))
      }
    }
  })
}

/** 基于 LCS 的逐行 diff；O(n·m)，资产正文规模下可接受。 */
function diffLines(a: string[], b: string[]): VersionDiffLine[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: VersionDiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ kind: 'remove', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

// ── rollbackVersion ───────────────────────────────────────────────────────
/** 以旧版本为蓝本生成新版本：正文型直接复用内容，文件型复用不可变 blob。 */
export function rollbackVersion(
  ctx: AssetsContext,
  assetId: number,
  condition: unknown,
  versionId: number
): { asset: AssetDetail; createdVersion: AssetVersion } {
  const id = positive(assetId)
  const vid = positive(versionId, 'versionId')
  const c = parseCondition(condition)
  const now = new Date().toISOString()

  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    if (row.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
    if (row.revision !== c.expectedRevision) {
      throw new AssetsStoreError('REVISION_CONFLICT', '资产已更新。', { currentRevision: row.revision })
    }
    if (c.hasVersion && c.expectedCurrentVersionId !== row.current_version_id) {
      throw new AssetsStoreError('VERSION_CONFLICT', '当前版本已改变。', { currentVersionId: row.current_version_id })
    }
    const target = selectVersion(s, id, vid)
    if (target === undefined) throw new AssetsStoreError('NOT_FOUND', '目标版本不存在。')

    if (target.file_path !== null) {
      // 复用不可变 blob：新建一条版本记录指向同一 blob，version 号递增。
      const next = (s.get<{ n: number }>('SELECT coalesce(max(version),0) n FROM asset_version WHERE asset_id=?', id)?.n ?? 0) + 1
      s.run(
        'INSERT INTO asset_version(asset_id,version,content,changelog,source_json,file_path,file_name,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, next, '', `回滚至 v${target.version}`, target.source_json, target.file_path, target.file_name, now
      )
      const newId = s.get<{ id: number }>('SELECT last_insert_rowid() id')?.id as number
      s.run('UPDATE asset SET current_version_id=?, revision=revision+1, updated_at=? WHERE id=?', newId, now, id)
      const fresh = selectAsset(s, id) as AssetRow
      return { asset: detail(s, fresh, ctx.layout), createdVersion: toAssetVersion(selectVersion(s, id, newId) as VersionRow) }
    }

    // 正文型：把旧版本内容作为新版本追加（内容不变，changelog 标注回滚），并递增 revision。
    void appendVersion(s, row, target.content, `回滚至 v${target.version}`, now, null, target.source_json)
    s.run('UPDATE asset SET revision=revision+1, updated_at=? WHERE id=?', now, id)
    const fresh = selectAsset(s, id) as AssetRow
    const newVersionId = fresh.current_version_id as number
    return { asset: detail(s, fresh, ctx.layout), createdVersion: toAssetVersion(selectVersion(s, id, newVersionId) as VersionRow) }
  })
}
