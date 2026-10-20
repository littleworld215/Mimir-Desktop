import { lazy, Suspense, useState } from 'react'
import { Button } from '@/components/ui/button'
import { researchControl, useResearchBusy, useResearchForm } from '../library/research/useResearchForm'
import type { PlanningCollection, PlanningInput, PlanningScope, PlanningType } from '../../../../shared/researchPlanningContracts'
import { PlanningLinkPicker, PlanningReferenceName } from './PlanningLinkPicker'

const SafeMarkdown = lazy(() => import('../assets/SafeMarkdown').then(module => ({ default: module.SafeMarkdown })))
export const planningStatusLabels = { planned: '计划中', active: '进行中', paused: '暂停', done: '已完成' } as const
interface Props {
  initial: PlanningInput; types: PlanningType[]; collections: PlanningCollection[]; busy?: boolean; scope?: PlanningScope
  save(input: PlanningInput): Promise<void>; onSaved(): void; onCancel(): void
}
export function PlanningEditor({ initial, types, collections, busy = false, scope, save, onSaved, onCancel }: Props) {
  const [mode, setMode] = useState<'edit' | 'preview' | 'split'>('edit')
  const [picker, setPicker] = useState<'project' | 'direction' | null>(null)
  useResearchBusy(picker !== null)
  const editor = useResearchForm(initial, async input => { await save(input); return onSaved }, busy)
  const { form, setForm } = editor, disabled = editor.busy || picker !== null
  const field = <K extends keyof PlanningInput>(key: K, value: PlanningInput[K]) => setForm({ ...form, [key]: value })
  return <form className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="编辑科研计划" onSubmit={e => { e.preventDefault(); void editor.persist() }} onKeyDown={e => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void editor.leave(onCancel) }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void editor.persist() }
  }}>
    <p className="text-xs text-muted-foreground" aria-live="polite">{editor.busy ? '保存中…' : editor.dirty ? '未保存更改' : '编辑已同步'} · Ctrl/Cmd+Enter 保存，Esc 返回</p>
    <label className="block text-sm">标题<input aria-label="标题" autoFocus required maxLength={500} className={researchControl} disabled={disabled} value={form.title} onChange={e => field('title', e.target.value)} /></label>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">记录类型<select aria-label="记录类型" className={researchControl} disabled={disabled} value={form.typeId} onChange={e => field('typeId', e.target.value)}>{types.filter(t => !t.deleted && t.kind === form.kind).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="text-sm">计划分组<select aria-label="计划分组" className={researchControl} disabled={disabled} value={form.collectionId} onChange={e => field('collectionId', e.target.value)}>{collections.filter(c => !c.deleted).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="text-sm">状态<select aria-label="状态" className={researchControl} disabled={disabled} value={form.status} onChange={e => setForm({ ...form, status: e.target.value as PlanningInput['status'], ...(form.kind === 'todo' ? { done: e.target.value === 'done' } : {}) })}>{Object.entries(planningStatusLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    </div>
    {form.kind === 'project' && <label className="block text-sm">项目分类<select aria-label="项目分类" className={researchControl} disabled={disabled} value={form.projectCategory ?? 'other'} onChange={e => field('projectCategory', e.target.value as PlanningInput['projectCategory'])}><option value="vertical">纵向项目</option><option value="horizontal">横向项目</option><option value="other">其他项目</option></select></label>}
    {form.kind === 'direction' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.majorDirection} disabled={disabled} onChange={e => field('majorDirection', e.target.checked)} />主要研究方向</label>}
    {form.kind === 'todo' && <fieldset className="grid gap-3 rounded border border-border p-3 sm:grid-cols-2"><legend className="text-sm">待办安排</legend>
      <label className="text-sm">截止日期<input aria-label="截止日期" type="date" className={researchControl} disabled={disabled} value={form.dueDate ?? ''} onChange={e => setForm({ ...form, dueDate: e.target.value || null, ...(e.target.value ? {} : { recurrence: null }) })} /></label>
      <label className="text-sm">我的一天日期<input aria-label="我的一天日期" type="date" className={researchControl} disabled={disabled} value={form.myDay ?? ''} onChange={e => field('myDay', e.target.value || null)} /></label>
      <label className="text-sm">优先级<select aria-label="优先级" className={researchControl} disabled={disabled} value={form.priority} onChange={e => field('priority', e.target.value as PlanningInput['priority'])}><option value="none">无</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      <label className="text-sm">重复规则<select aria-label="重复规则" className={researchControl} disabled={disabled || !form.dueDate} value={form.recurrence?.unit ?? ''} onChange={e => field('recurrence', e.target.value ? { unit: e.target.value as NonNullable<PlanningInput['recurrence']>['unit'], interval: form.recurrence?.interval ?? 1 } : null)}><option value="">不重复</option><option value="daily">按日</option><option value="weekly">按周</option><option value="monthly">按月</option></select></label>
      {form.recurrence && <label className="text-sm">重复间隔<input aria-label="重复间隔" type="number" min={1} max={99} required className={researchControl} disabled={disabled} value={form.recurrence.interval} onChange={e => field('recurrence', { ...form.recurrence!, interval: Number(e.target.value) })} /></label>}
      <p className="text-xs text-muted-foreground sm:col-span-2">我的一天需主动选择，与截止日期分开。完成周期待办时保留历史项并生成下一期；撤销完成不会删除下一期。</p>
    </fieldset>}
    {form.kind === 'schedule' && <fieldset className="grid gap-3 rounded border border-border p-3 sm:grid-cols-2"><legend className="text-sm">日程时间（本地日历时间）</legend>
      <label className="text-sm">日程日期<input aria-label="日程日期" type="date" required className={researchControl} disabled={disabled} value={form.schedule?.date ?? ''} onChange={e => field('schedule', { date: e.target.value, start: form.schedule?.start ?? null, end: form.schedule?.end ?? null })} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!form.schedule?.start && !form.schedule?.end} disabled={disabled || !form.schedule?.date} onChange={e => field('schedule', { date: form.schedule!.date, start: e.target.checked ? null : '09:00', end: e.target.checked ? null : '10:00' })} />全天日程</label>
      {(form.schedule?.start !== null || form.schedule?.end !== null) && form.schedule?.date && <><label className="text-sm">开始时间<input aria-label="开始时间" type="time" required className={researchControl} disabled={disabled} value={form.schedule.start ?? ''} onChange={e => field('schedule', { ...form.schedule!, start: e.target.value || null })} /></label><label className="text-sm">结束时间<input aria-label="结束时间" type="time" required className={researchControl} disabled={disabled} value={form.schedule.end ?? ''} onChange={e => field('schedule', { ...form.schedule!, end: e.target.value || null })} /></label></>}
    </fieldset>}
    {scope && (form.kind === 'project' || ['todo', 'generic', 'literature'].includes(form.kind)) && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{form.kind === 'project' ? '研究方向' : '科研项目'}：<PlanningReferenceName scope={scope} id={form.kind === 'project' ? form.directionId : form.projectId} /></span><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setPicker(form.kind === 'project' ? 'direction' : 'project')}>选择关联记录</Button><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => field(form.kind === 'project' ? 'directionId' : 'projectId', null)}>清除计划关联</Button></div>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.important} disabled={disabled} onChange={e => field('important', e.target.checked)} />标为重要</label>
    <div className="flex flex-wrap gap-2">{([['edit', '编辑原文'], ['preview', '阅读预览'], ['split', '分栏预览']] as const).map(([id, label]) => <Button key={id} size="sm" variant={mode === id ? 'default' : 'outline'} type="button" onClick={() => setMode(id)}>{label}</Button>)}</div>
    <div className={mode === 'split' ? 'grid gap-3 lg:grid-cols-2' : ''}>
      {mode !== 'preview' && <label className="block text-sm">正文<textarea aria-label="正文" rows={12} maxLength={100_000} className={`${researchControl} font-mono`} disabled={disabled} value={form.content} onChange={e => field('content', e.target.value)} /></label>}
      {mode !== 'edit' && <div className="min-w-0 rounded border border-border p-3"><Suspense fallback={<p role="status">正在准备阅读预览…</p>}><SafeMarkdown content={form.content} /></Suspense></div>}
    </div>
    <fieldset className="space-y-2"><legend className="text-sm">自定义字段</legend>{form.fields.map((value, i) => <div key={value.id} className="flex flex-wrap gap-2">
      <input aria-label={`字段${i + 1}名称`} className={`${researchControl} sm:max-w-44`} maxLength={200} disabled={disabled} value={value.name} onChange={e => field('fields', form.fields.map(f => f.id === value.id ? { ...f, name: e.target.value } : f))} />
      <textarea aria-label={`字段${i + 1}值`} rows={1} className={`${researchControl} flex-1`} maxLength={16_000} disabled={disabled} value={value.value} onChange={e => field('fields', form.fields.map(f => f.id === value.id ? { ...f, value: e.target.value } : f))} />
      <Button variant="outline" type="button" disabled={disabled} onClick={() => field('fields', form.fields.filter(f => f.id !== value.id))}>移除字段{i + 1}</Button>
    </div>)}<Button variant="outline" size="sm" type="button" disabled={disabled || form.fields.length >= 50} onClick={() => field('fields', [...form.fields, { id: crypto.randomUUID(), name: '', value: '' }])}>添加字段</Button></fieldset>
    {editor.error && <p ref={editor.errorRef} role="alert" tabIndex={-1} className="whitespace-pre-wrap text-sm text-destructive">{editor.error}</p>}
    <div className="sticky bottom-0 flex gap-2 border-t border-border bg-card py-3"><Button type="submit" disabled={disabled}>保存记录</Button><Button variant="outline" type="button" disabled={disabled} onClick={() => { void editor.leave(onCancel) }}>取消编辑</Button></div>
    {picker && scope && <PlanningLinkPicker scope={scope} kind={picker} onPick={id => field(picker === 'direction' ? 'directionId' : 'projectId', id)} onClose={() => setPicker(null)} />}
  </form>
}
