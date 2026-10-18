import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { libraryResearchApi } from '@/lib/libraryResearchApi'
import type { ResearchPackReply, ResearchRefreshPreview, ResearchResolvedItem, ResearchScope } from '../../../../../shared/libraryResearchContracts'
import { ResearchContent } from './ResearchContent'
import { researchMessage, useResearchBusy } from './useResearchForm'
interface Props { scope: ResearchScope; packId: string; revision: number; evidenceRevision: number; items: ResearchResolvedItem[]; onApplied(reply: ResearchPackReply): void; onClose(): void }
export function ReferenceRefreshDialog({ scope, packId, revision, evidenceRevision, items, onApplied, onClose }: Props) {
  const [chosen, setChosen] = useState<string[]>([]), [preview, setPreview] = useState<ResearchRefreshPreview>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const working = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useResearchBusy(busy)
  async function run(apply: boolean) {
    if (working.current || !chosen.length) return
    working.current = true; setBusy(true); setError('')
    try {
      const request = { scope, packId, expectedRevision: revision, expectedEvidenceRevision: evidenceRevision, itemIds: chosen }, api = libraryResearchApi()
      if (apply) {
        if (!preview) return
        const reply = await api.applyRefresh({ ...request, previewToken: preview.previewToken })
        if (!alive.current) return
        if (!reply.ok) throw Error(reply.message)
        onApplied(reply)
      } else {
        const reply = await api.previewRefresh(request)
        if (!alive.current) return
        if (!reply.ok) throw Error(reply.message)
        setPreview(reply)
      }
    } catch (failure) { if (alive.current) setError(researchMessage(failure)) }
    finally { working.current = false; if (alive.current) setBusy(false) }
  }
  function close() { if (!working.current) { alive.current = false; onClose() } }
  return <Dialog open onOpenChange={open => { if (!open) close() }}><DialogContent className="max-h-[88vh] max-w-5xl overflow-y-auto"><DialogHeader><DialogTitle>更新所选引用</DialogTitle><DialogDescription>先选择、再比较完整旧新内容。确认只推进所选条目，不修改证据原文或已有导出文件。</DialogDescription></DialogHeader>
    {items.map(item => <label className="flex items-center gap-2 text-sm" key={item.item.id}><input type="checkbox" disabled={busy} aria-label={`选择更新 ${item.item.id}`} checked={chosen.includes(item.item.id)} onChange={e => { setChosen(e.target.checked ? [...chosen, item.item.id] : chosen.filter(id => id !== item.item.id)); setPreview(undefined) }} />{item.question?.title ?? item.item.questionId} · 证据v{item.item.evidenceVersion}</label>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button disabled={busy || !chosen.length} onClick={() => void run(false)}>预览所选差异</Button>
    {preview?.changes.map(change => <section className="space-y-2 border-t border-border pt-3" key={change.itemId}><p className="text-sm">{change.eligible ? '可以更新' : change.reason ?? '当前引用无法更新'}</p><div className="grid min-w-0 gap-3 md:grid-cols-2"><section><h3 className="font-medium">旧版内容</h3><ResearchContent evidence={change.before.evidence} question={change.before.question} /></section><section><h3 className="font-medium">新版内容</h3><ResearchContent evidence={change.after?.evidence} question={change.after?.question} /></section></div></section>)}
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={close}>取消更新</Button><Button disabled={busy || !preview || preview.changes.some(c => !c.eligible)} onClick={() => void run(true)}>确认更新所选引用</Button></div>
  </DialogContent></Dialog>
}
