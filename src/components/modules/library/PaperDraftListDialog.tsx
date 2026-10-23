import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { DraftSummary, EditingDraft, EditingFields, EditingScope, EditingStatus } from '../../../../shared/libraryEditingContracts'
import { editingKindLabel, editingStatusLabel, PaperDraftRecovery } from './PaperDraftRecovery'
import type { PaperRecord } from './types'
export function PaperDraftListDialog({ scope, onClose, onRestore }: { scope: EditingScope; onClose(): void; onRestore(draft: EditingDraft): void | Promise<void> }) {
  const [rows, setRows] = useState<DraftSummary[]>([]), [detail, setDetail] = useState<{ draft: EditingDraft; status: EditingStatus }>(), [current, setCurrent] = useState<EditingFields>({}), [error, setError] = useState(''), [busy, setBusy] = useState(true)
  const generation = useRef(0)
  useEffect(() => { const g = ++generation.current; void load(g); return () => { ++generation.current } }, [scope.workspaceId, scope.spaceEpoch])
  async function load(g = generation.current) { setBusy(true); try { const r = await window.electronAPI!.libraryEditing.list({}); if (g !== generation.current) return; if (!r.ok) throw Error(r.message); if (r.scope.workspaceId !== scope.workspaceId || r.scope.spaceEpoch !== scope.spaceEpoch) throw Error('科研空间已变化，请重新打开'); setRows(r.drafts); setError('') } catch (e) { if (g === generation.current) setError(e instanceof Error ? e.message : '读取失败') } finally { if (g === generation.current) setBusy(false) } }
  async function inspect(id: string) {
    const g = ++generation.current; setBusy(true); setError(''); setDetail(undefined)
    try {
      const r = await window.electronAPI!.libraryEditing.detail({ scope, id }); if (g !== generation.current) return; if (!r.ok) throw Error(r.message)
      const papers = await window.electronAPI!.library.listPapers(); if (g !== generation.current) return
      if (!papers.ok) throw Error(papers.message || '当前文献读取失败，恢复草稿仍保留')
      const p = (papers.papers as PaperRecord[] | undefined)?.find(p => p.arxivId === r.draft.paperId)
      setCurrent(p ? r.draft.kind === 'tags' ? { tags: p.tags } : { notes: p.notes } : {}); setDetail(r)
    } catch (e) { if (g === generation.current) setError(e instanceof Error ? e.message : '读取失败') } finally { if (g === generation.current) setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>文献恢复草稿</DialogTitle><DialogDescription>按需查看原始输入；不会自动恢复、覆盖或清空。失联及已回收文献仍可复制。</DialogDescription></DialogHeader>
    {busy && <p role="status">读取中…</p>}{error && <p role="alert">{error}<Button onClick={() => void load()}>重试</Button></p>}
    {!busy && !error && !rows.length && <p>暂无恢复草稿。</p>}
    <div className="max-h-64 space-y-1 overflow-auto">{rows.map(d => <Button variant="outline" disabled={busy} className="h-auto w-full justify-start whitespace-normal text-left" key={d.id} onClick={() => void inspect(d.id)}>{d.paperId} · {editingKindLabel[d.kind]} · {d.updatedAt} · {editingStatusLabel[d.status]}</Button>)}</div>
    {detail && <PaperDraftRecovery key={detail.draft.id} {...detail} current={current} onRestore={onRestore} onDiscard={async d => { const r = await window.electronAPI!.libraryEditing.discard({ scope, id: d.id, revision: d.revision }); if (!r.ok) throw Error(r.message); setDetail(undefined); await load() }} />}
    <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
  </DialogContent></Dialog>
}
