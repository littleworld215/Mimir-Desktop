import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ResearchPackInput, ResearchPackReply, ResearchPackVersion, ResearchQuestionSummary, ResearchResult, ResearchScope } from '../../../../../shared/libraryResearchContracts'
import { EvidencePicker } from './EvidencePicker'
import { researchControl, useResearchForm } from './useResearchForm'
interface Props { scope: ResearchScope; projectId: string; initial?: ResearchPackVersion; revision: number; evidenceRevision: number | null; questions: ResearchQuestionSummary[]; externalBusy?: boolean; save(input: ResearchPackInput, evidenceRevision?: number): Promise<ResearchResult<ResearchPackReply>>; onSaved?(reply: ResearchPackReply): void; onCancel?(): void }
export function MaterialPackEditor({ scope, projectId, initial, revision, evidenceRevision, questions, externalBusy = false, save, onSaved, onCancel }: Props) {
  const observed = useRef(evidenceRevision), [pickerQuestionId, setPickerQuestionId] = useState(''), [selectedQuestionId, setSelectedQuestionId] = useState('')
  const editor = useResearchForm<ResearchPackInput>({ projectId: initial?.projectId ?? projectId, title: initial?.title ?? '', note: initial?.note ?? '', items: initial?.items.map(i => ({ kind: 'existing', itemId: i.id, section: i.section, note: i.note })) ?? [] }, async input => {
    const reply = await save(input, observed.current ?? undefined)
    if (!reply.ok) throw Error(reply.message)
    return () => onSaved?.(reply)
  }, externalBusy)
  const eligibleQuestions = questions.filter(q => !q.archived && q.projectId === editor.form.projectId)
  const questionId = eligibleQuestions.some(q => q.id === selectedQuestionId) ? selectedQuestionId : eligibleQuestions[0]?.id ?? ''
  // 一次选择固定问题身份，异步刷新只能调整下一次入口，不能重标已选证据。
  const referenceQuestionId = pickerQuestionId || questionId
  const disabled = editor.busy || Boolean(pickerQuestionId)
  const existing = (id: string) => initial?.items.find(i => i.id === id)
  const excluded = [...(initial?.items.filter(i => i.questionId === referenceQuestionId).map(i => i.cardId) ?? []), ...editor.form.items.filter(i => i.kind === 'new' && i.questionId === referenceQuestionId).map(i => i.kind === 'new' ? i.cardId : '')]
  function move(index: number, offset: number) { const items = [...editor.form.items], to = index + offset; if (to < 0 || to >= items.length) return; [items[index], items[to]] = [items[to]!, items[index]!]; editor.setForm({ ...editor.form, items }) }
  return <><form className="space-y-3 rounded border border-border bg-card p-3" onSubmit={e => { e.preventDefault(); void editor.persist() }} onKeyDown={e => { if (e.key === 'Escape' && !disabled && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); void editor.leave(onCancel); return }; if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void editor.persist() } }}>
    <p className="text-xs text-muted-foreground" aria-live="polite">研究修订 {revision} · {editor.busy ? '保存中…' : editor.dirty ? '未保存' : '编辑已同步'} · 既有引用固定版本，改版请使用差异预览</p>
    {editor.error && <p role="alert" ref={editor.errorRef} tabIndex={-1} className="text-destructive whitespace-pre-wrap">{editor.error}</p>}
    <label className="block text-xs">素材包标题<input aria-label="素材包标题" className={researchControl} disabled={disabled} value={editor.form.title} onChange={e => editor.setForm({ ...editor.form, title: e.target.value })} /></label>
    <label className="block text-xs">素材包说明<textarea aria-label="素材包说明" className={researchControl} rows={3} disabled={disabled} value={editor.form.note} onChange={e => editor.setForm({ ...editor.form, note: e.target.value })} /></label>
    <div className="flex flex-wrap items-end gap-2"><label className="min-w-44 flex-1 text-xs">选入问题<select aria-label="选入问题" className={researchControl} disabled={disabled} value={questionId} onChange={e => setSelectedQuestionId(e.target.value)}><option value="">请选择问题组</option>{eligibleQuestions.map(q => <option key={q.id} value={q.id}>{q.title || '未命名问题'}</option>)}</select></label><Button type="button" variant="outline" disabled={disabled || !questionId || evidenceRevision === null || initial?.archived} onClick={() => setPickerQuestionId(questionId)}>从问题组选入证据</Button></div>
    {editor.form.items.map((item, index) => <fieldset key={item.kind === 'existing' ? item.itemId : `${item.questionId}:${item.cardId}`} disabled={disabled} className="space-y-2 rounded border border-border p-2"><legend className="text-xs">材料 {index + 1} · {item.kind === 'existing' ? `固定证据v${existing(item.itemId)?.evidenceVersion ?? '?'}` : '保存时固定当前版本'}</legend><p className="text-xs break-all text-muted-foreground">{item.kind === 'existing' ? existing(item.itemId)?.cardId : item.cardId}</p>
      <label className="block text-xs">拟写小节<input aria-label={`拟写小节 ${index + 1}`} className={researchControl} value={item.section} onChange={e => editor.setForm({ ...editor.form, items: editor.form.items.map((old, i) => i === index ? { ...old, section: e.target.value } : old) })} /></label>
      <label className="block text-xs">个人写作说明<textarea aria-label={`素材说明 ${index + 1}`} className={researchControl} value={item.note} rows={2} onChange={e => editor.setForm({ ...editor.form, items: editor.form.items.map((old, i) => i === index ? { ...old, note: e.target.value } : old) })} /></label>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled || index === 0} aria-label={`上移条目 ${index + 1}`} onClick={() => move(index, -1)}>上移</Button><Button type="button" variant="outline" disabled={disabled || index === editor.form.items.length - 1} aria-label={`下移条目 ${index + 1}`} onClick={() => move(index, 1)}>下移</Button><Button type="button" variant="outline" disabled={disabled} aria-label={`移除条目 ${index + 1}`} onClick={() => editor.setForm({ ...editor.form, items: editor.form.items.filter((_, i) => i !== index) })}>移除</Button></div>
    </fieldset>)}
    <p className="text-xs text-muted-foreground">共{editor.form.items.length}条。导出按小节首次出现分组，组内保留相对顺序；移除后需先保存才能重新选入同一引用。</p>
    <div className="flex gap-2"><Button type="submit" disabled={disabled}>保存素材包</Button><Button type="button" variant="outline" disabled={disabled} onClick={() => { editor.discard(); onCancel?.() }}>取消编辑</Button></div>
  </form>{pickerQuestionId && <EvidencePicker scope={scope} projectId={editor.form.projectId} questionId={pickerQuestionId} initialIds={[]} excludedIds={excluded} onApply={(ids, nextRevision) => { observed.current = nextRevision; editor.setForm({ ...editor.form, items: [...editor.form.items, ...ids.map(cardId => ({ kind: 'new' as const, questionId: pickerQuestionId, cardId, section: '', note: '' }))] }); setPickerQuestionId('') }} onClose={() => setPickerQuestionId('')} />}</>
}
