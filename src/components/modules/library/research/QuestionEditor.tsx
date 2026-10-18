import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ResearchQuestionInput, ResearchQuestionReply, ResearchQuestionVersion, ResearchResult, ResearchScope } from '../../../../../shared/libraryResearchContracts'
import { EvidencePicker } from './EvidencePicker'
import { researchControl, useResearchForm } from './useResearchForm'

interface Props { scope: ResearchScope; projectId: string; initial?: ResearchQuestionVersion; revision: number; evidenceRevision: number | null; externalBusy?: boolean; save(input: ResearchQuestionInput, evidenceRevision?: number): Promise<ResearchResult<ResearchQuestionReply>>; onSaved?(reply: ResearchQuestionReply): void; onCancel?(): void }
export function QuestionEditor({ scope, projectId, initial, revision, evidenceRevision, externalBusy = false, save, onSaved, onCancel }: Props) {
  const observed = useRef(evidenceRevision), [picker, setPicker] = useState(false)
  const editor = useResearchForm<ResearchQuestionInput>({ projectId: initial?.projectId ?? projectId, title: initial?.title ?? '', question: initial?.question ?? '', note: initial?.note ?? '', evidenceCardIds: [...(initial?.evidenceCardIds ?? [])] }, async input => {
    const reply = await save(input, observed.current ?? undefined)
    if (!reply.ok) throw Error(reply.message)
    return () => onSaved?.(reply)
  }, externalBusy)
  const disabled = editor.busy || picker
  return <><form className="space-y-3 rounded border border-border bg-card p-3" onSubmit={e => { e.preventDefault(); void editor.persist() }} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void editor.persist() } }}>
    <p className="text-xs text-muted-foreground" aria-live="polite">研究修订 {revision} · {editor.busy ? '保存中…' : editor.dirty ? '未保存' : '编辑已同步'} · 分组不改写证据原文或核对状态</p>
    {editor.error && <p role="alert" className="text-destructive whitespace-pre-wrap">{editor.error}</p>}
    {(['title', 'question', 'note'] as const).map((key, i) => <label key={key} className="block text-xs">{['问题标题', '具体研究问题', '问题说明'][i]} · {Array.from(editor.form[key]).length}/{key === 'title' ? 200 : 2000}<textarea aria-label={['问题标题', '具体研究问题', '问题说明'][i]} rows={key === 'title' ? 1 : 3} disabled={disabled} className={researchControl} value={editor.form[key]} onChange={e => editor.setForm({ ...editor.form, [key]: e.target.value })} /></label>)}
    <div className="space-y-1 text-xs"><p>已关联 {editor.form.evidenceCardIds.length} 张卡；旧的失联关联可移除，不会删除证据。</p>{editor.form.evidenceCardIds.map(id => <div key={id} className="flex items-center gap-2 break-all"><span>{id}</span><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => editor.setForm({ ...editor.form, evidenceCardIds: editor.form.evidenceCardIds.filter(other => other !== id) })}>移除关联</Button></div>)}</div>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled || evidenceRevision === null || Boolean(initial?.archived)} onClick={() => setPicker(true)}>选择证据</Button><Button type="submit" disabled={disabled}>保存问题</Button><Button type="button" variant="outline" disabled={disabled} onClick={() => { editor.discard(); onCancel?.() }}>取消编辑</Button></div>
  </form>{picker && <EvidencePicker scope={scope} projectId={editor.form.projectId} initialIds={editor.form.evidenceCardIds} onApply={(ids, nextRevision) => { observed.current = nextRevision; editor.setForm({ ...editor.form, evidenceCardIds: ids }); setPicker(false) }} onClose={() => setPicker(false)} />}</>
}
