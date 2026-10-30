import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { registerEvidenceEditor } from '@/lib/evidenceEditGuard'
import type { EvidenceCardReply, EvidenceFields, EvidenceResult, EvidenceVersion } from '../../../../../shared/libraryEvidenceContracts'
import { EvidenceTemplatePicker } from './EvidenceTemplatePicker'
import { evidenceTemplateHints, type EvidenceTemplateId } from '@/lib/evidenceTemplates'

export const evidenceControl = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
export function evidenceFields(paperId: string, projectIds: string[], initial?: EvidenceVersion): EvidenceFields {
  return { paperId: initial?.paperId ?? paperId, projectIds: [...(initial?.projectIds ?? projectIds)], question: initial?.question ?? '', claim: initial?.claim ?? '', quote: initial?.quote ?? '', method: initial?.method ?? '', datasetOrMaterial: initial?.datasetOrMaterial ?? '', finding: initial?.finding ?? '', limitation: initial?.limitation ?? '', comment: initial?.comment ?? '', relation: initial?.relation ?? 'unassessed', locator: { ...(initial?.locator ?? {}) } }
}
interface Props {
  paperId: string; projectIds: string[]; initial?: EvidenceVersion; revision: number
  externalBusy?: boolean
  initialFields?: EvidenceFields
  papers?: { arxivId: string; title: string }[]; projects?: { id: string; title: string }[]
  save(input: EvidenceFields): Promise<EvidenceResult<EvidenceCardReply>>
  onSaved?(reply: EvidenceCardReply): void; onCancel?(): void
}
export function EvidenceEditor({ paperId, projectIds, initial, initialFields, revision, externalBusy = false, papers = [], projects = [], save, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<EvidenceFields>(() => initial || !initialFields ? evidenceFields(paperId, projectIds, initial) : { ...initialFields, projectIds: [...initialFields.projectIds], locator: { ...initialFields.locator } }), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const base = useRef(JSON.stringify(evidenceFields(paperId, projectIds, initial))), active = useRef(true), busyRef = useRef(false), formRef = useRef(form)
  const actions = useRef({ save, onSaved }); actions.current = { save, onSaved }
  const externalBusyRef = useRef(externalBusy); externalBusyRef.current = externalBusy
  const disabled = busy || externalBusy
  const [templateMode, setTemplateMode] = useState<EvidenceTemplateId>('general')
  const hints = evidenceTemplateHints(templateMode)
  formRef.current = form
  const dirty = JSON.stringify(form) !== base.current
  function change<K extends keyof EvidenceFields>(key: K, value: EvidenceFields[K]) {
    if (busyRef.current || externalBusyRef.current) return
    const next = { ...formRef.current, [key]: value }; formRef.current = next; setForm(next)
  }
  function discard() { if (!busyRef.current && !externalBusyRef.current) { const restored = JSON.parse(base.current) as EvidenceFields; formRef.current = restored; setForm(restored); setError('') } }
  async function persist(): Promise<boolean> {
    if (busyRef.current || externalBusyRef.current || !active.current) return false
    busyRef.current = true; setBusy(true); setError('')
    try {
      const reply = await actions.current.save(formRef.current)
      if (!active.current) return false
      if (!reply.ok) { setError(`${reply.code}：${reply.message}`); return false }
      const next = evidenceFields(paperId, projectIds, reply.card.versions[reply.card.currentVersion - 1])
      base.current = JSON.stringify(next); formRef.current = next; setForm(next)
      actions.current.onSaved?.(reply)
      return true
    } catch { if (active.current) setError('保存失败，全部输入已保留，请重试'); return false }
    finally { busyRef.current = false; if (active.current) setBusy(false) }
  }
  const saveRef = useRef(persist); saveRef.current = persist
  useEffect(() => {
    active.current = true
    const remove = registerEvidenceEditor({ isDirty: () => JSON.stringify(formRef.current) !== base.current, isBusy: () => busyRef.current || externalBusyRef.current, save: () => saveRef.current(), discard })
    return () => { active.current = false; remove() }
  }, [])
  const text = (key: 'question' | 'claim' | 'quote' | 'method' | 'datasetOrMaterial' | 'finding' | 'limitation' | 'comment', label: string, limit: number) => <label className="block space-y-1" key={key}><span className="text-xs font-medium">{label} <span className="text-muted-foreground">{Array.from(form[key]).length}/{limit}</span></span><textarea aria-label={label} placeholder={hints[key]} className={`${evidenceControl} min-h-[72px] resize-y`} rows={key === 'quote' ? 6 : 3} value={form[key]} disabled={disabled} onChange={e => change(key, e.target.value)} />{hints[key] && <span className="block whitespace-pre-wrap text-xs text-muted-foreground">填写提示：{hints[key]}</span>}</label>
  return <form className="space-y-4 p-3" onSubmit={e => { e.preventDefault(); void persist() }} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void persist() } }}>
    <p className="text-xs text-muted-foreground" aria-live="polite">文档修订 {revision} · {busy ? '保存中…' : dirty ? '未保存' : '编辑已同步'} · 修改人工内容后恢复为草稿</p>
    {error && <p role="alert" className="text-sm text-destructive whitespace-pre-wrap break-words">{error}</p>}
    <EvidenceTemplatePicker fields={form} mode={templateMode} disabled={disabled} onModeChange={setTemplateMode} onApply={next => { if (!busyRef.current && !externalBusyRef.current) { formRef.current = next; setForm(next) } }} />
    <fieldset className="space-y-2" disabled={disabled}><legend className="font-medium text-sm">原文与来源</legend>
      {papers.length > 0 && <label className="block text-xs">来源文献<select aria-label="来源文献" className={evidenceControl} value={form.paperId} onChange={e => change('paperId', e.target.value)}>{!papers.some(p => p.arxivId === form.paperId) && <option value={form.paperId}>已移除文献 · {form.paperId}</option>}{papers.map(p => <option key={p.arxivId} value={p.arxivId}>{p.title}</option>)}</select></label>}
      {text('question', '研究问题', 2000)}{text('quote', '原文摘录', 20000)}
      <div className="grid grid-cols-2 gap-2">{(['pageStart', 'pageEnd'] as const).map((key, index) => <label key={key} className="text-xs">{index ? 'PDF结束页' : 'PDF物理起始页'}<input aria-label={index ? 'PDF结束页' : 'PDF物理起始页'} className={evidenceControl} type="number" min="1" step="1" value={form.locator[key] ?? ''} onChange={e => change('locator', { ...form.locator, [key]: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>)}</div>
      {(['printedPageLabel', 'section', 'figureOrTable'] as const).map((key, index) => <label className="block text-xs" key={key}>{['印刷页码标签', '章节', '图表标识'][index]}<input aria-label={['印刷页码标签', '章节', '图表标识'][index]} className={evidenceControl} value={form.locator[key] ?? ''} onChange={e => change('locator', { ...form.locator, [key]: e.target.value })} /></label>)}
    </fieldset>
    <fieldset className="space-y-2" disabled={disabled}><legend className="font-medium text-sm">比较字段（人工整理）</legend>{text('method', '方法', 4000)}{text('datasetOrMaterial', '数据或材料', 4000)}{text('finding', '主要发现', 4000)}{text('limitation', '局限', 4000)}</fieldset>
    <fieldset className="space-y-2" disabled={disabled}><legend className="font-medium text-sm">个人判断</legend>{text('claim', '待比较判断', 2000)}{text('comment', '个人评注', 20000)}
      <label className="block text-xs">与判断的关系<select aria-label="与判断的关系" className={evidenceControl} value={form.relation} onChange={e => change('relation', e.target.value as EvidenceFields['relation'])}><option value="unassessed">未判断</option><option value="supports">支持</option><option value="opposes">反对</option><option value="mixed">混合</option></select></label>
      {(projects.length > 0 || form.projectIds.length > 0) && <div className="space-y-1 text-xs"><p>关联项目（可多选）</p>{[...projects, ...form.projectIds.filter(id => !projects.some(p => p.id === id)).map(id => ({ id, title: `失效项目 · ${id}` }))].map(p => <label key={p.id} className="flex items-center gap-2"><input type="checkbox" checked={form.projectIds.includes(p.id)} onChange={e => change('projectIds', e.target.checked ? [...form.projectIds, p.id] : form.projectIds.filter(id => id !== p.id))} />{p.title}</label>)}</div>}
    </fieldset>
    <div className="sticky bottom-0 flex flex-wrap gap-2 bg-card py-2"><Button type="submit" disabled={disabled}>{busy ? '保存中…' : '保存证据'}</Button><Button type="button" variant="outline" disabled={disabled} onClick={() => { discard(); onCancel?.() }}>取消编辑</Button></div>
  </form>
}
