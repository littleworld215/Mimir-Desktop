import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { previewEvidenceTemplate, type EvidenceTemplateId } from '@/lib/evidenceTemplates'
import type { EvidenceFields } from '../../../../../shared/libraryEvidenceContracts'
interface Props { fields: EvidenceFields; mode: EvidenceTemplateId; disabled: boolean; onModeChange(mode: EvidenceTemplateId): void; onApply(fields: EvidenceFields): void }
const labels: Partial<Record<keyof EvidenceFields, string>> = { question: '研究问题', method: '方法', datasetOrMaterial: '数据或材料', finding: '主要发现', limitation: '局限', comment: '个人评注' }
export function EvidenceTemplatePicker({ fields, mode, disabled, onModeChange, onApply }: Props) {
  const [preview, setPreview] = useState<{ value: ReturnType<typeof previewEvidenceTemplate>; base: string }>(), [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  function apply() {
    if (!preview || disabled) return
    if (preview.base !== JSON.stringify(fields)) { setError('输入已变化，请取消后重新预览；当前内容保留。'); return }
    onApply(preview.value.next); setPreview(undefined)
  }
  return <div className="space-y-2 rounded border border-border p-2 text-sm">
    <label>填写框架 <select aria-label="填写框架" className="rounded border border-border bg-background p-1 text-foreground" disabled={disabled} value={mode} onChange={event => onModeChange(event.target.value as EvidenceTemplateId)}><option value="general">通用</option><option value="t2i-fairness">T2I公平性</option></select></label>
    <p className="text-xs text-muted-foreground">人工填写辅助；切换只改说明，不生成结论、不改写输入或自动核对来源。</p>
    <Button ref={trigger} type="button" variant="outline" disabled={disabled || mode === 'general'} onClick={() => { setError(''); setPreview({ value: previewEvidenceTemplate(fields, mode), base: JSON.stringify(fields) }) }}>预览空白填写提纲</Button>
    <Dialog open={!!preview} onOpenChange={open => { if (!open) setPreview(undefined) }}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}>
      <DialogHeader><DialogTitle>插入填写提纲预览</DialogTitle><DialogDescription>只填空字符串字段；原文、空白输入、来源与项目不改动。插入后仍需显式保存。</DialogDescription></DialogHeader>
      <div className="max-h-[55vh] space-y-2 overflow-auto">{preview?.value.changed.map(key => <div key={key}><p className="text-sm font-medium">{labels[key]}</p><pre className="whitespace-pre-wrap break-words text-xs">{String(preview.value.next[key])}</pre></div>)}{preview?.value.changed.length === 0 && <p>没有可填的空字段，全部输入保持。</p>}</div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => setPreview(undefined)}>取消插入</Button><Button type="button" disabled={disabled || !preview?.value.changed.length} onClick={apply}>仅插入空字段</Button></div>
    </DialogContent></Dialog>
  </div>
}
