import { Button } from '@/components/ui/button'
import type { ResearchQuestionSummary } from '../../../../../shared/libraryResearchContracts'
export function QuestionList({ items, busy, onSelect }: { items: ResearchQuestionSummary[]; busy: boolean; onSelect(id: string): void }) {
  return <div className="space-y-2">{items.map(q => <Button key={q.id} variant="outline" disabled={busy} aria-label={`打开问题 ${q.title}`} className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => onSelect(q.id)}><span className="break-words">{q.title || '未命名问题'} · v{q.currentVersion}{q.archived ? ' · 已归档' : ''}<br /><span className="text-xs text-muted-foreground">{q.cardCount}张卡 · {q.problemCount === null ? '来源尚未能检查' : `${q.problemCount}项需留意`}</span></span></Button>)}</div>
}
