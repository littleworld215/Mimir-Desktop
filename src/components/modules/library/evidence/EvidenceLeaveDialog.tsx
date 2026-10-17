import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { hasEvidenceWork, requestEvidenceLeave, setEvidenceLeaveChooser, type EvidenceLeaveChoice } from '@/lib/evidenceEditGuard'

export function EvidenceLeaveDialog() {
  const [open, setOpen] = useState(false)
  const pending = useRef<((choice: EvidenceLeaveChoice) => void) | null>(null)
  function answer(choice: EvidenceLeaveChoice) { pending.current?.(choice); pending.current = null; setOpen(false) }
  useEffect(() => {
    const remove = setEvidenceLeaveChooser(() => new Promise(resolve => { pending.current = resolve; setOpen(true) }))
    window.mimirRequestEvidenceLeave = requestEvidenceLeave
    const closing = (event: BeforeUnloadEvent) => { if (hasEvidenceWork()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', closing)
    return () => { remove(); delete window.mimirRequestEvidenceLeave; pending.current?.('cancel'); pending.current = null; window.removeEventListener('beforeunload', closing) }
  }, [])
  return <Dialog open={open} onOpenChange={value => { if (!value) answer('cancel') }}><DialogContent>
    <DialogHeader><DialogTitle>存在未保存的证据编辑</DialogTitle><DialogDescription>保存成功后才能离开；失败或冲突时保留全部输入。丢弃只放弃本次未保存的编辑。</DialogDescription></DialogHeader>
    <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => answer('cancel')}>留在这里</Button><Button variant="destructive" onClick={() => answer('discard')}>丢弃后离开</Button><Button onClick={() => answer('save')}>保存后离开</Button></div>
  </DialogContent></Dialog>
}
