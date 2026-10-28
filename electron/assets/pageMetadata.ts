import type { AssetSummary, AssetTag } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsWriteSession } from './types'
import type { AssetRow } from './assetRepository'

interface PathRow { code: string; name: string; parent_code: string | null }
interface VersionRow { id: number; asset_id: number; version: number }

/** Hydrate only the selected page. All maps die with this guarded transaction. */
export function pageSummaries(s: AssetsWriteSession, rows: AssetRow[]): AssetSummary[] {
  if (!rows.length) return []
  const placeholders = (values: unknown[]) => values.map(() => '?').join(',')
  const codes = [...new Set(rows.map(row => row.category))]
  // UNION on code alone terminates corrupt cycles; resolve below preserves legacy errors.
  const paths = new Map(s.all<PathRow>(`WITH RECURSIVE required(code) AS (
    SELECT code FROM asset_category WHERE code IN (${placeholders(codes)})
    UNION SELECT c.parent_code FROM asset_category c JOIN required r ON c.code=r.code WHERE c.parent_code IS NOT NULL
  ) SELECT code,name,parent_code FROM asset_category WHERE code IN (SELECT code FROM required)`, ...codes).map(row => [row.code, row]))
  const resolved = new Map<string, string[]>()
  const pathFor = (code: string): string[] => {
    const cached = resolved.get(code)
    if (cached) return [...cached]
    const names: string[] = []
    const visited = new Set<string>()
    let current: string | null = code
    while (current !== null) {
      if (visited.has(current)) throw new AssetsStoreError('CYCLE', '分类路径存在循环。')
      visited.add(current)
      const category = paths.get(current)
      if (!category) throw new AssetsStoreError('BAD_CATEGORY', '资产分类不存在。')
      names.unshift(category.name)
      current = category.parent_code
    }
    resolved.set(code, names)
    return [...names]
  }
  // Resolve in page order before reading other metadata, retaining category errors.
  for (const row of rows) pathFor(row.category)
  const versionIds = [...new Set(rows.flatMap(row => row.current_version_id === null ? [] : [row.current_version_id]))]
  const versions = new Map((versionIds.length ? s.all<VersionRow>(
    `SELECT id,asset_id,version FROM asset_version WHERE id IN (${placeholders(versionIds)})`, ...versionIds) : []).map(row => [row.id, row]))
  const ids = rows.map(row => row.id)
  const tags = new Map<number, AssetTag[]>()
  for (const row of s.all<AssetTag & { asset_id: number }>(
    `SELECT a.asset_id,t.id,t.name,t.color,t.revision FROM tag t JOIN asset_tag a ON a.tag_id=t.id WHERE a.asset_id IN (${placeholders(ids)}) ORDER BY a.asset_id,t.id`, ...ids)) {
    const list = tags.get(row.asset_id) ?? []
    list.push({ id: row.id, name: row.name, color: row.color, revision: row.revision })
    tags.set(row.asset_id, list)
  }
  return rows.map(row => {
    const version = row.current_version_id === null ? undefined : versions.get(row.current_version_id)
    return {
      isFavorite: row.is_favorite, lastUsedAt: row.last_used_at,
      id: row.id, code: row.code, name: row.name, category: row.category, categoryPath: pathFor(row.category),
      description: row.description, storageType: row.storage_type, kind: row.kind,
      currentVersion: version?.asset_id === row.id ? version.version : null,
      archivedAt: row.archived_at, revision: row.revision, updatedAt: row.updated_at,
      tags: tags.get(row.id) ?? []
    }
  })
}
