import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetReferenceGraph, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, controlClass } from './assetsUi'
import { useAssetPreview } from './useAssetPreview'

export function ReferenceGraph({ scope, assetId, disabled, onSelect }: { scope: WorkspaceRequest; assetId: number; disabled: boolean; onSelect: (id: number) => void }) {
  const [open, setOpen] = useState(false), [depth, setDepth] = useState(2)
  const preview = useAssetPreview<{ graph: AssetReferenceGraph }>(), marker = useId().replace(/:/g, '')
  function read(next = depth) { return preview.read(() => assetsApi.referenceGraph({ ...scope, assetId, depth: next })) }
  const graph = preview.value?.graph, columns = Math.max(1, Math.ceil(Math.sqrt(graph?.nodes.length ?? 1)))
  const positions = new Map(graph?.nodes.map((node, index) => [node.id, { x: (index % columns) * 160 + 80, y: Math.floor(index / columns) * 90 + 45 }]))
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => { setOpen(true); void read() }}>查看关系图</Button><select aria-label="关系深度" className={controlClass.replace('w-full ', '') + ' w-auto'} disabled={disabled} value={depth} onChange={e => { const next = Number(e.target.value); setDepth(next); preview.clear(); if (open) void read(next) }}>{[1, 2, 3].map(d => <option key={d} value={d}>{d} 层关系</option>)}</select></div>
    <AssetError message={preview.error} />{preview.error && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void read()}>重试关系图</Button>}
    {preview.loading && <p role="status">正在读取关系图…</p>}
    {graph && <><p className="text-xs text-muted-foreground">{graph.nodes.length} 个资产 · {graph.edges.length} 条关系 · {graph.depth} 层</p>{graph.truncated && <p role="status" className="text-sm">仅显示部分关系：已达到预览上限，可从关联资产继续查看。</p>}
      <div className="max-h-96 overflow-auto rounded-md border"><svg aria-label="关系图" role="group" width={columns * 160} height={Math.ceil(graph.nodes.length / columns) * 90}>
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="currentColor" /></marker></defs>
        {graph.edges.map(edge => {
          const from = positions.get(edge.sourceAssetId), to = positions.get(edge.targetAssetId)
          if (!from || !to) return null
          const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy)
          const boundary = Math.min(dx ? 70 / Math.abs(dx) : Infinity, dy ? 22 / Math.abs(dy) : Infinity) + 4 / length
          const paired = graph.edges.some(other => other.sourceAssetId === edge.targetAssetId && other.targetAssetId === edge.sourceAssetId)
          const bend = paired ? 18 : 0
          const path = `M${from.x + dx * boundary} ${from.y + dy * boundary} Q${(from.x + to.x) / 2 - dy / length * bend} ${(from.y + to.y) / 2 + dx / length * bend} ${to.x - dx * boundary} ${to.y - dy * boundary}`
          return <path key={`${edge.sourceAssetId}:${edge.targetAssetId}`} d={path} fill="none" stroke="currentColor" opacity="0.55" markerEnd={`url(#${marker})`} />
        })}
        {graph.nodes.map(node => { const point = positions.get(node.id)!; return <g key={node.id} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={`打开关系资产 ${node.name}${node.archivedAt ? '（已归档）' : ''}`} className="cursor-pointer focus:outline focus:outline-2 focus:outline-primary" onClick={() => { if (!disabled) onSelect(node.id) }} onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(node.id) } }}><rect x={point.x - 70} y={point.y - 22} width="140" height="44" rx="6" className="fill-background stroke-border" /><text x={point.x} y={point.y + 4} textAnchor="middle" className="fill-foreground text-xs">{node.name.slice(0, 8)}{node.name.length > 8 ? '…' : ''}{node.archivedAt ? '（已归档）' : ''}</text></g> })}
      </svg></div>
      <details><summary className="cursor-pointer text-sm">关系清单</summary><ul className="space-y-1 text-xs">{graph.edges.map(edge => <li key={`${edge.sourceAssetId}:${edge.targetAssetId}`}>{graph.nodes.find(n => n.id === edge.sourceAssetId)?.name}{graph.nodes.find(n => n.id === edge.sourceAssetId)?.archivedAt ? '（已归档）' : ''} → {graph.nodes.find(n => n.id === edge.targetAssetId)?.name}{graph.nodes.find(n => n.id === edge.targetAssetId)?.archivedAt ? '（已归档）' : ''}</li>)}</ul></details>
    </>}
  </section>
}
