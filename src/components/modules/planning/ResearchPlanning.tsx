import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { researchControl, useResearchBusy } from '../library/research/useResearchForm'
import { PlanningEditor, planningStatusLabels } from './PlanningEditor'
import { PlanningManager } from './PlanningManager'
import { PLANNING_KIND_LABELS, emptyPlanningInput } from '../../../../shared/researchPlanningDefaults'
import type { PlanningCollection, PlanningCommand, PlanningFilter, PlanningInput, PlanningItem, PlanningKind, PlanningScope, PlanningType } from '../../../../shared/researchPlanningContracts'

type Metadata = { scope: PlanningScope; revision: number; collections: PlanningCollection[]; types: PlanningType[] }
type Editing = { input: PlanningInput; itemId?: string; scope: PlanningScope; revision: number }
const inputOf = ({ id, createdAt, updatedAt, ...input }: PlanningItem): PlanningInput => input
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，原资料保留'
function planningApi() { const api = window.electronAPI?.researchPlanning; if (!api) throw Error('科研计划桌面接口不可用，请重新打开新版工作台'); return api }
export function ResearchPlanning() {
  const [meta, setMeta] = useState<Metadata | null>(null), [items, setItems] = useState<PlanningItem[]>([]), [total, setTotal] = useState(0)
  const [kind, setKind] = useState<PlanningKind>('project'), [keyword, setKeyword] = useState(''), [debounced, setDebounced] = useState(''), [collectionId, setCollectionId] = useState(''), [typeId, setTypeId] = useState('')
  const [status, setStatus] = useState(''), [archive, setArchive] = useState<'exclude' | 'only' | 'include'>('exclude'), [trash, setTrash] = useState(false), [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Editing | null>(null), [manager, setManager] = useState(false), [board, setBoard] = useState(false)
  const [selected, setSelected] = useState<string[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const sequence = useRef(0), working = useRef(false), lastFocus = useRef<HTMLElement | null>(null), errorRef = useRef<HTMLParagraphElement>(null)
  useResearchBusy(busy)
  useEffect(() => { const timer = setTimeout(() => { setDebounced(keyword); setPage(1) }, 200); return () => clearTimeout(timer) }, [keyword])
  const filter = useMemo<PlanningFilter>(() => ({ kind, keyword: debounced, ...(collectionId ? { collectionId } : {}), ...(typeId ? { typeId } : {}), ...(status ? { status: status as PlanningInput['status'] } : {}), archived: archive, deleted: trash }), [kind, debounced, collectionId, typeId, status, archive, trash])
  const reload = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true); setError('')
    try {
      const api = window.electronAPI?.researchPlanning
      if (!api) throw Error('当前入口缺少科研计划接口，请使用新版桌面程序')
      const bootstrap = await api.bootstrap({})
      if (request !== sequence.current) return
      if (!bootstrap.ok) throw Error(bootstrap.message)
      const result = await api.list({ scope: bootstrap.scope, filter, page })
      if (request !== sequence.current) return
      if (!result.ok) throw Error(result.message)
      if (result.revision !== bootstrap.revision) throw Error('计划在加载期间有更新，请重试加载')
      setMeta({ ...bootstrap, revision: result.revision }); setItems(result.items); setTotal(result.total); setSelected([])
    } catch (failure) { if (request === sequence.current) { setError(errorMessage(failure)); setItems([]); setMeta(null) } }
    finally { if (request === sequence.current) setLoading(false) }
  }, [filter, page])
  useEffect(() => { void reload(); return () => { sequence.current++ } }, [reload])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  const locked = busy || loading || editing !== null
  function closeEditor() { setEditing(null); setTimeout(() => { if (lastFocus.current?.isConnected) lastFocus.current.focus() }, 0) }
  function begin(item?: PlanningItem) {
    if (!meta || locked) return
    lastFocus.current = document.activeElement as HTMLElement
    const input = item ? inputOf(item) : { ...emptyPlanningInput(kind), ...(collectionId ? { collectionId } : {}), ...(typeId ? { typeId } : {}) }
    setEditing({ input, itemId: item?.id, scope: meta.scope, revision: meta.revision })
  }
  async function execute(command: PlanningCommand, preview = false) {
    if (!meta || working.current) throw Error('操作进行中，请稍后重试')
    working.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await planningApi().mutate({ scope: meta.scope, expectedRevision: meta.revision, command, preview })
      if (!result.ok) throw Error(result.message)
      if (!preview) { setNotice(`已处理 ${result.affectedCount} 条记录`); await reload() }
      return result
    } catch (failure) { setError(errorMessage(failure)); throw failure }
    finally { working.current = false; setBusy(false) }
  }
  const action = (command: PlanningCommand) => { void execute(command).catch(() => {}) }
  function changeKind(next: PlanningKind) { if (locked) return; setKind(next); setTypeId(''); setPage(1); setSelected([]) }
  function card(item: PlanningItem, at: number) {
    return <article key={item.id} className="space-y-2 rounded-lg border border-border bg-card p-3" draggable={kind === 'project' && !locked && !trash} onDragStart={e => e.dataTransfer.setData('application/x-mimir-planning', item.id)}>
      <div className="flex items-start gap-2"><input type="checkbox" aria-label={`选择${item.title}`} checked={selected.includes(item.id)} disabled={locked} onChange={e => setSelected(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><button className="min-w-0 flex-1 break-words text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={locked} onClick={() => begin(item)}>{item.important ? '★ ' : ''}{item.majorDirection ? '主方向 · ' : ''}{item.title}</button></div>
      <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.content || '暂无正文'}</p>
      <p className="text-xs text-muted-foreground">{planningStatusLabels[item.status]} · {meta?.collections.find(c => c.id === item.collectionId)?.name} {item.projectCategory ? `· ${ { vertical: '纵向', horizontal: '横向', other: '其他' }[item.projectCategory]}` : ''}</p>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={locked || trash} onClick={() => action({ kind: 'duplicate', id: item.id })}>复制</Button>
        <Button size="sm" variant="outline" disabled={locked} onClick={() => action({ kind: 'bulk', ids: [item.id], patch: { archived: !item.archived } })}>{item.archived ? '取消归档' : '归档'}</Button>
        <Button size="sm" variant="outline" disabled={locked} onClick={() => action({ kind: 'bulk', ids: [item.id], patch: { deleted: !item.deleted } })}>{item.deleted ? '恢复记录' : '移入回收站'}</Button>
        <Button size="sm" variant="outline" disabled={locked || trash || at === 0 || items[at - 1]?.typeId !== item.typeId} onClick={() => action({ kind: 'reorder', ids: [item.id, items[at - 1]!.id] })}>上移</Button>
        <Button size="sm" variant="outline" disabled={locked || trash || at === items.length - 1 || items[at + 1]?.typeId !== item.typeId} onClick={() => action({ kind: 'reorder', ids: [items[at + 1]!.id, item.id] })}>下移</Button>
      </div>
      {kind === 'project' && <label className="block text-xs">调整项目状态<select aria-label={`调整${item.title}状态`} className={researchControl} disabled={locked} value={item.status} onChange={e => action({ kind: 'bulk', ids: [item.id], patch: { status: e.target.value as PlanningInput['status'] } })}>{Object.entries(planningStatusLabels).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>}
    </article>
  }
  return <div className="h-full overflow-y-auto bg-background p-4 text-foreground sm:p-6"><div className="mx-auto max-w-7xl space-y-4">
    <header className="flex flex-wrap items-center gap-3"><div className="mr-auto"><h1 className="module-title text-xl font-semibold">科研计划</h1><p className="text-xs text-muted-foreground">当前科研空间内的人工规划 · 不自动执行Agent任务</p></div><Button variant="outline" disabled={locked || !meta} onClick={() => setManager(true)}>分组与类型</Button><Button disabled={locked || !meta || manager} onClick={() => begin()}>新建{PLANNING_KIND_LABELS[kind]}</Button></header>
    <nav className="flex flex-wrap gap-2" aria-label="计划内容">{(['project', 'direction', 'generic'] as const).map(id => <Button key={id} variant={id === kind ? 'default' : 'outline'} disabled={locked || manager} onClick={() => changeKind(id)}>{PLANNING_KIND_LABELS[id]}</Button>)}</nav>
    {error && <div className="space-y-2"><p role="alert" ref={errorRef} tabIndex={-1} className="text-sm text-destructive">{error}</p><Button variant="outline" disabled={busy} onClick={() => { void reload() }}>重试加载</Button></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {manager && meta ? <PlanningManager collections={meta.collections} types={meta.types} busy={busy} execute={execute} onClose={() => setManager(false)} /> : editing && meta ? <PlanningEditor initial={editing.input} types={meta.types} collections={meta.collections} busy={busy} save={async input => { const result = await planningApi().save({ scope: editing.scope, expectedRevision: editing.revision, itemId: editing.itemId, input }); if (!result.ok) throw Error(result.message) }} onSaved={() => { closeEditor(); void reload() }} onCancel={closeEditor} /> : <>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <input aria-label="搜索科研计划" placeholder="搜索标题、正文、字段" className={researchControl} value={keyword} disabled={locked} onChange={e => setKeyword(e.target.value)} />
        <select aria-label="筛选分组" className={researchControl} value={collectionId} disabled={locked} onChange={e => { setCollectionId(e.target.value); setPage(1) }}><option value="">全部分组</option>{meta?.collections.filter(c => !c.deleted).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select aria-label="筛选记录类型" className={researchControl} value={typeId} disabled={locked} onChange={e => { setTypeId(e.target.value); setPage(1) }}><option value="">全部同类类型</option>{meta?.types.filter(t => !t.deleted && t.kind === kind).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select aria-label="筛选状态" className={researchControl} value={status} disabled={locked} onChange={e => { setStatus(e.target.value); setPage(1) }}><option value="">全部状态</option>{Object.entries(planningStatusLabels).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select>
        <select aria-label="归档范围" className={researchControl} value={archive} disabled={locked} onChange={e => { setArchive(e.target.value as typeof archive); setPage(1) }}><option value="exclude">未归档</option><option value="only">仅归档</option><option value="include">含归档</option></select>
        <Button variant="outline" disabled={locked} onClick={() => { setTrash(!trash); setArchive('include'); setPage(1) }}>{trash ? '返回有效记录' : '查看回收站'}</Button>
      </div>
      {kind === 'project' && <div className="flex gap-2"><Button size="sm" variant={board ? 'outline' : 'default'} onClick={() => setBoard(false)}>项目列表</Button><Button size="sm" variant={board ? 'default' : 'outline'} onClick={() => setBoard(true)}>项目看板</Button></div>}
      {selected.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm"><span>已选{selected.length}条</span><Button size="sm" variant="outline" disabled={locked} onClick={() => action({ kind: 'bulk', ids: selected, patch: { archived: archive !== 'only' } })}>{archive === 'only' ? '批量取消归档' : '批量归档'}</Button><Button size="sm" variant="outline" disabled={locked} onClick={() => action({ kind: 'bulk', ids: selected, patch: { deleted: !trash } })}>{trash ? '批量恢复' : '批量移入回收站'}</Button><select aria-label="批量移动分组" className={`${researchControl} sm:max-w-52`} value="" disabled={locked} onChange={e => { if (e.target.value) action({ kind: 'bulk', ids: selected, patch: { collectionId: e.target.value } }) }}><option value="">移动到分组…</option>{meta?.collections.filter(c => !c.deleted).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      <div className="flex items-center gap-3 text-xs text-muted-foreground"><span>{loading ? '正在加载…' : `共${total}条 · 当前第${page}页（每页50条）`}</span><Button size="sm" variant="outline" disabled={locked || items.length === 0} onClick={() => setSelected(selected.length === items.length ? [] : items.map(i => i.id))}>选择／取消本页</Button><Button size="sm" variant="outline" disabled={locked} onClick={() => { void reload() }}>刷新列表</Button></div>
      <section aria-busy={loading}>{!loading && !error && items.length === 0 ? <p className="rounded border border-dashed border-border p-8 text-sm text-muted-foreground">当前没有匹配的科研计划。</p> : board && kind === 'project' ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{Object.entries(planningStatusLabels).map(([id, text]) => <section key={id} className="min-w-0 space-y-2 rounded border border-border p-2" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const itemId = e.dataTransfer.getData('application/x-mimir-planning'); if (!locked && items.some(item => item.id === itemId)) action({ kind: 'bulk', ids: [itemId], patch: { status: id as PlanningInput['status'] } }) }}><h2 className="text-sm font-medium">{text}（本页{items.filter(i => i.status === id).length}）</h2>{items.map((item, at) => item.status === id ? card(item, at) : null)}</section>)}</div> : <div className="grid gap-3 lg:grid-cols-2">{items.map(card)}</div>}</section>
      <div className="flex gap-2"><Button variant="outline" disabled={locked || page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><Button variant="outline" disabled={locked || page * 50 >= total} onClick={() => setPage(page + 1)}>下一页</Button></div>
    </>}
  </div></div>
}
