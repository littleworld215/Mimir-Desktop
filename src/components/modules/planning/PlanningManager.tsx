import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import { researchControl, useResearchForm } from '../library/research/useResearchForm'
import type { PlanningCollection, PlanningCommand, PlanningType } from '../../../../shared/researchPlanningContracts'

interface Props { collections: PlanningCollection[]; types: PlanningType[]; busy: boolean; execute(command: PlanningCommand, preview?: boolean): Promise<{ affectedCount: number }>; onClose(): void }
type Definition = { kind: 'collection' | 'type'; id?: string; name: string; itemKind: 'generic' | 'todo' }
export function PlanningManager(props: Props) {
  const [editing, setEditing] = useState<Definition | null>(null), [removing, setRemoving] = useState<{ kind: 'collection' | 'type'; id: string; name: string; itemKind?: PlanningType['kind'] } | null>(null)
  async function select(value: Definition | null) { if (await requestEvidenceLeave()) { setRemoving(null); setEditing(value) } }
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="分组与类型管理">
    <div className="flex flex-wrap gap-2"><h2 className="mr-auto font-medium">分组与类型</h2><Button variant="outline" disabled={props.busy} onClick={() => { void requestEvidenceLeave().then(ok => { if (ok) props.onClose() }) }}>返回记录</Button></div>
    <p className="text-xs text-muted-foreground">分组位于当前科研空间内；删除前必须选择迁移目标，不删除已有记录。</p>
    {editing ? <DefinitionEditor key={`${editing.kind}:${editing.id ?? 'new'}`} initial={editing} busy={props.busy} execute={props.execute} close={() => setEditing(null)} /> : removing ? <DeleteDefinition key={removing.id} {...props} item={removing} close={() => setRemoving(null)} /> : <>
      <div className="flex gap-2"><Button size="sm" onClick={() => { void select({ kind: 'collection', name: '', itemKind: 'generic' }) }}>新建分组</Button><Button size="sm" variant="outline" onClick={() => { void select({ kind: 'type', name: '', itemKind: 'generic' }) }}>新建记录类型</Button></div>
      {(['collection', 'type'] as const).map(kind => <div key={kind}><h3 className="mb-2 text-sm font-medium">{kind === 'collection' ? '计划分组' : '记录类型'}</h3><ul className="space-y-1">{(kind === 'collection' ? props.collections : props.types).filter(v => !v.deleted).map(value => <li key={value.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm">
        <span className="mr-auto">{value.name}</span><Button size="sm" variant="outline" onClick={() => { void select({ kind, id: value.id, name: value.name, itemKind: 'kind' in value && value.kind === 'todo' ? 'todo' : 'generic' }) }}>重命名{value.name}</Button>
        {value.id !== 'default' && !('builtin' in value && value.builtin) && <Button size="sm" variant="outline" onClick={() => setRemoving({ kind, id: value.id, name: value.name, itemKind: kind === 'type' ? props.types.find(t => t.id === value.id)?.kind : undefined })}>删除{value.name}</Button>}
      </li>)}</ul></div>)}
    </>}
  </section>
}
function DefinitionEditor({ initial, busy, execute, close }: { initial: Definition; busy: boolean; execute: Props['execute']; close(): void }) {
  const editor = useResearchForm(initial, async input => {
    const command: PlanningCommand = input.kind === 'collection' ? { kind: 'collection', id: input.id, name: input.name } : { kind: 'type', id: input.id, name: input.name, ...(input.id ? {} : { itemKind: input.itemKind }) }
    await execute(command); return close
  }, busy)
  return <form className="space-y-3" onSubmit={e => { e.preventDefault(); void editor.persist() }}>
    <label className="block text-sm">名称<input aria-label="管理名称" className={researchControl} autoFocus required maxLength={200} disabled={editor.busy} value={editor.form.name} onChange={e => editor.setForm({ ...editor.form, name: e.target.value })} /></label>
    {initial.kind === 'type' && !initial.id && <label className="block text-sm">类型语义<select aria-label="类型语义" className={researchControl} disabled={editor.busy} value={editor.form.itemKind} onChange={e => editor.setForm({ ...editor.form, itemKind: e.target.value as 'generic' | 'todo' })}><option value="generic">普通记录</option><option value="todo">人工待办</option></select></label>}
    {editor.error && <p role="alert" tabIndex={-1} ref={editor.errorRef} className="text-sm text-destructive">{editor.error}</p>}
    <div className="flex gap-2"><Button type="submit" disabled={editor.busy}>保存定义</Button><Button type="button" variant="outline" disabled={editor.busy} onClick={() => { void editor.leave(close) }}>取消管理</Button></div>
  </form>
}
function DeleteDefinition({ item, collections, types, busy, execute, close }: Props & { item: { kind: 'collection' | 'type'; id: string; name: string; itemKind?: PlanningType['kind'] }; close(): void }) {
  const [target, setTarget] = useState(''), [preview, setPreview] = useState<number | null>(null), [error, setError] = useState('')
  const destinations = item.kind === 'collection' ? collections.filter(c => !c.deleted && c.id !== item.id) : types.filter(t => !t.deleted && t.id !== item.id && t.kind === item.itemKind)
  const command: PlanningCommand = { kind: item.kind, id: item.id, name: item.name, deleted: true, moveTo: target }
  async function submit(isPreview: boolean) {
    setError('')
    try { const result = await execute(command, isPreview); if (isPreview) setPreview(result.affectedCount); else close() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '未执行，原资料保留') }
  }
  return <div className="space-y-3"><p>删除“{item.name}”后，全部记录（含归档与回收站）迁移到所选目标。</p>
    <label className="block text-sm">迁移目标<select aria-label="迁移目标" className={researchControl} disabled={busy} value={target} onChange={e => { setTarget(e.target.value); setPreview(null) }}><option value="">请选择目标</option>{destinations.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    {preview !== null && <p role="status">将迁移 {preview} 条记录，正文与状态保留；尚未执行。</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={!target || busy} onClick={() => { void submit(true) }}>预览删除影响</Button><Button variant="destructive" disabled={preview === null || busy} onClick={() => { void submit(false) }}>确认迁移并删除</Button><Button variant="outline" disabled={busy} onClick={close}>取消删除</Button></div>
  </div>
}
