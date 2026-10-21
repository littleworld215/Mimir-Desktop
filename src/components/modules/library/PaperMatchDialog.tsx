import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ArxivEntry, WebSearchEntry } from './types'

interface Props {
  source: WebSearchEntry
  candidates: ArxivEntry[]
  trigger: HTMLElement | null
  busy: boolean
  error: string
  onClose(): void
  onConfirm(candidate: ArxivEntry): Promise<void>
}

/** 不预选、不推测置信度，让用户比较原网页与候选原始书目信息。 */
export function PaperMatchDialog({ source, candidates, trigger, busy, error, onClose, onConfirm }: Props) {
  const [selected, setSelected] = useState<number | null>(null)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" onCloseAutoFocus={event => {
      event.preventDefault()
      if (trigger?.isConnected) trigger.focus()
    }}>
      <DialogHeader>
        <DialogTitle>核对候选论文</DialogTitle>
        <DialogDescription>按标题检索不代表同一篇论文。请比较标题、作者、标识和日期，选择正确候选后再导入。</DialogDescription>
      </DialogHeader>
      <section className="min-w-0 rounded border p-3 text-sm break-words" aria-label="原网页">
        <p className="font-medium">{source.title}</p>
        <p className="text-xs text-muted-foreground">{source.url}</p>
        <p className="mt-2 whitespace-pre-wrap">{source.content}</p>
      </section>
      <fieldset disabled={busy} className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-medium">论文候选（未自动选中）</legend>
        {candidates.map((candidate, index) => <label key={`${index}:${candidate.id}`} className="flex gap-2 rounded border p-3 text-sm cursor-pointer">
          <input type="radio" name="paper-match" aria-label={`${candidate.title} · ${candidate.id}`} checked={selected === index} onChange={() => setSelected(index)} />
          <span className="min-w-0 break-words">
            <span className="block font-medium">{candidate.title}</span>
            <span className="block">{candidate.authors.join(', ') || '作者未知'}</span>
            <span className="block text-xs text-muted-foreground">来源：{candidate.source || '未提供，请核对下方链接'}</span>
            <span className="block text-xs text-muted-foreground">标识：{candidate.id} · 来源日期：{candidate.published || '未知'}</span>
            <span className="block text-xs text-muted-foreground">{candidate.url}</span>
            <span className="mt-1 block whitespace-pre-wrap">{candidate.summary}</span>
          </span>
        </label>)}
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {busy && <p role="status" className="text-sm">正在导入…</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button disabled={busy || selected === null} onClick={() => { if (selected !== null) void onConfirm(candidates[selected]!) }}>确认导入</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
