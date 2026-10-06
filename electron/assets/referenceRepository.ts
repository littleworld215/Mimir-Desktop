import type { AssetReferenceEdge } from '../../shared/assetsContracts'
import type { AssetsWriteSession } from './types'
import type { AssetRow } from './assetRepository'

export function referenceRows(s: AssetsWriteSession, assetId: number, incoming: boolean): AssetRow[] {
  const owner = incoming ? 'target_asset_id' : 'source_asset_id'
  const related = incoming ? 'source_asset_id' : 'target_asset_id'
  return s.all<AssetRow>(`SELECT a.* FROM asset_reference r JOIN asset a ON a.id=r.${related} WHERE r.${owner}=? ORDER BY a.id`, assetId)
}

/** Fetch only not-yet-expanded incident edges, plus one row for an honest budget signal. */
export function incidentEdges(s: AssetsWriteSession, frontier: number[], expanded: number[], limit: number): AssetReferenceEdge[] {
  const marks = (ids: number[]) => ids.map(() => '?').join(',')
  const excluded = expanded.length ? ` AND source_asset_id NOT IN (${marks(expanded)}) AND target_asset_id NOT IN (${marks(expanded)})` : ''
  return s.all<AssetReferenceEdge>(`SELECT source_asset_id sourceAssetId,target_asset_id targetAssetId FROM asset_reference
    WHERE (source_asset_id IN (${marks(frontier)}) OR target_asset_id IN (${marks(frontier)}))${excluded}
    ORDER BY source_asset_id,target_asset_id LIMIT ?`, ...frontier, ...frontier, ...expanded, ...expanded, limit)
}
