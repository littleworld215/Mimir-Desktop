import type { AssetReferenceChange, AssetReferenceGraph, AssetReferences } from '../../shared/assetsContracts'
import { selectAsset, summary } from './assetRepository'
import { incidentEdges, referenceRows } from './referenceRepository'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'

function input(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.includes(k))) throw new AssetsStoreError('BAD_REQUEST', '参见参数非法。')
  return raw as Record<string, unknown>
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new AssetsStoreError('BAD_REQUEST', '参见标识及版本须为正安全整数。')
  return value
}
function asset(s: AssetsWriteSession, id: number) {
  const row = selectAsset(s, id)
  if (!row) throw new AssetsStoreError('NOT_FOUND', '参见资产不存在。')
  return row
}
function changeReference(ctx: AssetsContext, raw: unknown, adding: boolean): AssetReferenceChange {
  const data = input(raw, ['sourceAssetId', 'targetAssetId', 'expectedRevision'])
  const sourceId = positive(data.sourceAssetId), targetId = positive(data.targetAssetId), revision = positive(data.expectedRevision)
  if (sourceId === targetId) throw new AssetsStoreError('BAD_REQUEST', '资产不能参见自身。')
  return ctx.write(s => {
    const source = asset(s, sourceId)
    asset(s, targetId)
    if (source.revision !== revision) throw new AssetsStoreError('REVISION_CONFLICT', '源资产已改变，请重新加载。', { currentRevision: source.revision })
    if (source.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复源资产再修改参见。')
    const now = new Date().toISOString()
    const result = adding
      ? s.run('INSERT INTO asset_reference(source_asset_id,target_asset_id,created_at) VALUES(?,?,?) ON CONFLICT(source_asset_id,target_asset_id) DO NOTHING', sourceId, targetId, now)
      : s.run('DELETE FROM asset_reference WHERE source_asset_id=? AND target_asset_id=?', sourceId, targetId)
    if (result.changes) s.run('UPDATE asset SET revision=revision+1,updated_at=? WHERE id=?', now, sourceId)
    return { changed: result.changes !== 0, revision: source.revision + (result.changes ? 1 : 0) }
  })
}
export function addReference(ctx: AssetsContext, raw: unknown): AssetReferenceChange { return changeReference(ctx, raw, true) }
export function removeReference(ctx: AssetsContext, raw: unknown): AssetReferenceChange { return changeReference(ctx, raw, false) }
export function getReferences(ctx: AssetsContext, raw: unknown): AssetReferences {
  const id = positive(input(raw, ['assetId']).assetId)
  return ctx.write(s => {
    const row = asset(s, id)
    return { assetId: id, revision: row.revision, references: referenceRows(s, id, false).map(row => summary(s, row)), referencedBy: referenceRows(s, id, true).map(row => summary(s, row)) }
  })
}

export function getReferenceGraph(ctx: AssetsContext, raw: unknown): AssetReferenceGraph {
  const data = input(raw, ['assetId', 'depth'])
  const id = positive(data.assetId), depth = positive(data.depth === undefined ? 2 : data.depth)
  if (depth > 3) throw new AssetsStoreError('BAD_REQUEST', '关系深度需在1–3之间。')
  return ctx.write(s => {
    const graph: AssetReferenceGraph = { rootId: id, depth, nodes: [summary(s, asset(s, id))], edges: [], truncated: false }
    const visited = new Set([id])
    const expanded: number[] = []
    let frontier = [id]
    for (let level = 0; level < depth && frontier.length; level++) {
      const remaining = 1000 - graph.edges.length
      const edges = incidentEdges(s, frontier, expanded, remaining + 1)
      const next: number[] = []
      for (const edge of edges) {
        if (graph.edges.length === 1000) { graph.truncated = true; break }
        const unknown = [edge.sourceAssetId, edge.targetAssetId].filter(node => !visited.has(node))
        if (visited.size + unknown.length > 200) { graph.truncated = true; continue }
        for (const node of unknown) {
          graph.nodes.push(summary(s, asset(s, node)))
          visited.add(node)
          next.push(node)
        }
        graph.edges.push(edge)
      }
      expanded.push(...frontier)
      frontier = next.sort((a, b) => a - b)
    }
    graph.nodes.sort((a, b) => a.id - b.id)
    graph.edges.sort((a, b) => a.sourceAssetId - b.sourceAssetId || a.targetAssetId - b.targetAssetId)
    return graph
  })
}
