import type { PlanningDraft, PlanningItem } from '../../../../shared/researchPlanningContracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function PlanningRecovery({ draft, live, revision, onRestore, onClose }: { draft: PlanningDraft; live?: PlanningItem; revision: number; onRestore(useCurrent: boolean, asNew: boolean): void; onClose(): void }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>核对恢复草稿</DialogTitle><DialogDescription>草稿尚未正式保存。核对当前记录后再继续，正文不会自动合并。</DialogDescription></DialogHeader>
    <div className="grid min-w-0 gap-3 md:grid-cols-2"><section className="min-w-0 space-y-2"><h3>恢复草稿：{draft.input.title || '未命名'}</h3><p className="text-xs text-muted-foreground">基于修订{draft.baseRevision} · {draft.updatedAt}</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-sm">{draft.input.content || '（无正文）'}</pre><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(draft.input, null, 2)}</pre></section>
      <section className="min-w-0 space-y-2"><h3>当前正式记录：{live?.title ?? (draft.itemId ? '原记录已失联' : '新记录草稿')}</h3><p className="text-xs text-muted-foreground">当前修订{revision} · {live?.updatedAt}</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-sm">{live?.content ?? '没有对应正式正文'}</pre>{live && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(live, null, 2)}</pre>}</section></div>
    <div className="flex flex-wrap gap-2"><Button onClick={() => onRestore(true, !!draft.itemId && !live)}>已核对，采用当前修订继续编辑{draft.itemId && !live ? '为新记录' : ''}</Button><Button variant="outline" onClick={() => onRestore(false, false)} disabled={!!draft.itemId && !live}>保留草稿原修订编辑</Button><Button variant="outline" onClick={onClose}>取消恢复</Button></div>
  </DialogContent></Dialog>
}
