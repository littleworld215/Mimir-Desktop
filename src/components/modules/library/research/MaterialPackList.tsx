import { Button } from '@/components/ui/button'
import type { ResearchPackSummary } from '../../../../../shared/libraryResearchContracts'
export function MaterialPackList({ items, busy, onSelect }: { items: ResearchPackSummary[]; busy: boolean; onSelect(id: string): void }) {
  return <div className="space-y-2">{items.map(p => <Button key={p.id} variant="outline" disabled={busy} aria-label={`打开素材包 ${p.title}`} className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => onSelect(p.id)}><span className="break-words">{p.title || '未命名素材包'} · v{p.currentVersion}{p.archived ? ' · 已归档' : ''}<br /><span className="text-xs text-muted-foreground">{p.itemCount}条材料 · {p.problemCount === null ? '来源尚未能检查' : `${p.problemCount}项需留意`}</span></span></Button>)}</div>
}
