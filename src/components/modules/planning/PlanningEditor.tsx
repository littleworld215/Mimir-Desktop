import { lazy, Suspense, useState } from 'react'
import { Button } from '@/components/ui/button'
import { researchControl, useResearchForm } from '../library/research/useResearchForm'
import type { PlanningCollection, PlanningInput, PlanningType } from '../../../../shared/researchPlanningContracts'

const SafeMarkdown = lazy(() => import('../assets/SafeMarkdown').then(module => ({ default: module.SafeMarkdown })))
export const planningStatusLabels = { planned: '计划中', active: '进行中', paused: '暂停', done: '已完成' } as const
interface Props {
  initial: PlanningInput; types: PlanningType[]; collections: PlanningCollection[]; busy?: boolean
  save(input: PlanningInput): Promise<void>; onSaved(): void; onCancel(): void
}
export function PlanningEditor({ initial, types, collections, busy = false, save, onSaved, onCancel }: Props) {
  const [mode, setMode] = useState<'edit' | 'preview' | 'split'>('edit')
  const editor = useResearchForm(initial, async input => { await save(input); return onSaved }, busy)
  const { form, setForm } = editor, disabled = editor.busy
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
      <label className="text-sm">状态<select aria-label="状态" className={researchControl} disabled={disabled} value={form.status} onChange={e => field('status', e.target.value as PlanningInput['status'])}>{Object.entries(planningStatusLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    </div>
    {form.kind === 'project' && <label className="block text-sm">项目分类<select aria-label="项目分类" className={researchControl} disabled={disabled} value={form.projectCategory ?? 'other'} onChange={e => field('projectCategory', e.target.value as PlanningInput['projectCategory'])}><option value="vertical">纵向项目</option><option value="horizontal">横向项目</option><option value="other">其他项目</option></select></label>}
    {form.kind === 'direction' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.majorDirection} disabled={disabled} onChange={e => field('majorDirection', e.target.checked)} />主要研究方向</label>}
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
  </form>
}
