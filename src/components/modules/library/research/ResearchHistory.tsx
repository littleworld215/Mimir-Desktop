import { Button } from '@/components/ui/button'
import type { ResearchPack, ResearchQuestion } from '../../../../../shared/libraryResearchContracts'
export function ResearchHistory({ entity, selectedVersion, busy, onSelect }: { entity: ResearchPack | ResearchQuestion; selectedVersion: number; busy: boolean; onSelect(version: number): void }) {
  return <details className="rounded border border-border p-2"><summary className="cursor-pointer text-sm">修订历史 · 旧版本只读</summary><div className="mt-2 flex flex-wrap gap-2">{entity.versions.map(v => <Button key={v.version} size="sm" variant={v.version === selectedVersion ? 'default' : 'outline'} disabled={busy} onClick={() => onSelect(v.version)}>v{v.version} · {v.archived ? '归档' : '保留'} · {v.updatedAt}</Button>)}</div></details>
}
