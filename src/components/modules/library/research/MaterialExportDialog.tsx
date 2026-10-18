import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { libraryResearchApi } from '@/lib/libraryResearchApi'
import type { ResearchExportPreview, ResearchScope } from '../../../../../shared/libraryResearchContracts'
import { researchMessage, useResearchBusy } from './useResearchForm'
interface Props { scope: ResearchScope; packId: string; packVersion: number; revision: number; evidenceRevision: number; onClose(): void }
export function MaterialExportDialog({ scope, packId, packVersion, revision, evidenceRevision, onClose }: Props) {
  const [preview, setPreview] = useState<ResearchExportPreview>(), [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0)
  const generation = useRef(0), working = useRef(false)
  useResearchBusy(busy)
  useEffect(() => {
    const token = ++generation.current; setBusy(true); setError(''); setPreview(undefined)
    void (async () => {
      try {
        const reply = await libraryResearchApi().export({ scope, packId, packVersion, expectedRevision: revision, expectedEvidenceRevision: evidenceRevision, mode: 'preview' })
        if (generation.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        setPreview(reply)
      } catch (failure) { if (generation.current === token) setError(researchMessage(failure)) }
      finally { if (generation.current === token) setBusy(false) }
    })()
    return () => { generation.current++ }
  }, [scope.workspaceId, scope.spaceEpoch, packId, packVersion, revision, evidenceRevision, retry])
  async function save() {
    if (!preview || working.current) return
    const token = generation.current; working.current = true; setBusy(true); setError('')
    try {
      const reply = await libraryResearchApi().export({ scope, packId, packVersion, expectedRevision: revision, expectedEvidenceRevision: evidenceRevision, mode: 'save', previewToken: preview.previewToken })
      if (generation.current !== token) return
      if (!reply.ok) throw Error(reply.message)
      setNotice(reply.canceled ? '已取消保存，未创建文件' : reply.saved ? `已保存为 ${reply.fileName ?? '新文件'}` : '未保存')
    } catch (failure) { if (generation.current === token) { setError(researchMessage(failure)); setPreview(undefined) } }
    finally { working.current = false; if (generation.current === token) setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !working.current) onClose() }}><DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>导出写作素材</DialogTitle><DialogDescription>以下为将保存的完整Markdown文本。草稿与相反判断保留；仅保存为新文件。</DialogDescription></DialogHeader>
    {busy && <p role="status">正在准备或保存素材…</p>}{error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
    {preview && <><p className="text-sm">素材v{preview.packVersion} · {preview.entryCount}条材料 · {preview.uniqueCardCount}张唯一卡 · {preview.problemCount}条需留意</p><pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3 text-xs">{preview.markdown}</pre></>}
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={working.current} onClick={onClose}>关闭预览</Button><Button variant="outline" disabled={busy} onClick={() => setRetry(v => v + 1)}>重新预览</Button><Button disabled={busy || !preview || Boolean(error)} onClick={() => void save()}>保存为新文件</Button></div>
  </DialogContent></Dialog>
}
