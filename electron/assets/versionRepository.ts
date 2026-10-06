/**
 * 资产版本查询仓储（I1-04）。
 *
 * 只读查询；所有写操作仍由 `assetService` / `fileService` 在受守卫事务内完成。
 * 版本表 append-only，本模块不提供任何 UPDATE / DELETE。
 */
import type { AssetVersion, AssetVersionSummary } from '../../shared/assetsContracts'
import type { AssetsWriteSession } from './types'

export interface VersionRow {
  id: number
  asset_id: number
  version: number
  content: string
  file_path: string | null
  file_name: string | null
  changelog: string
  source_json: string
  created_at: string
}

/** 取某资产下某版本（校验归属，越界返回 undefined）。 */
export function selectVersion(s: AssetsWriteSession, assetId: number, versionId: number): VersionRow | undefined {
  return s.get<VersionRow>('SELECT * FROM asset_version WHERE id=? AND asset_id=?', versionId, assetId)
}

/** 版本总数（用于分页 total）。 */
export function countVersions(s: AssetsWriteSession, assetId: number): number {
  return s.get<{ n: number }>('SELECT count(*) n FROM asset_version WHERE asset_id=?', assetId)?.n ?? 0
}

/** 分页列表：按 version 倒序（最新在前）。 */
export function listVersionRows(s: AssetsWriteSession, assetId: number, page: number, pageSize: number): VersionRow[] {
  return s.all<VersionRow>(
    'SELECT * FROM asset_version WHERE asset_id=? ORDER BY version DESC LIMIT ? OFFSET ?',
    assetId, pageSize, (page - 1) * pageSize
  )
}

/** 单行 → 列表 DTO（不含正文）。 */
export function versionSummary(row: VersionRow): AssetVersionSummary {
  return {
    id: row.id,
    assetId: row.asset_id,
    version: row.version,
    filePath: row.file_path,
    fileName: row.file_name,
    changelog: row.changelog,
    createdAt: row.created_at
  }
}

/** 单行 → 完整版本 DTO（含正文与 source）。 */
export function toAssetVersion(row: VersionRow): AssetVersion {
  return { ...versionSummary(row), content: row.content, sourceJson: row.source_json }
}
