import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { researchControl, useResearchBusy } from '../library/research/useResearchForm'
import type { PlanningHostKind, PlanningHostReference, PlanningScope } from '../../../../shared/researchPlanningContracts'

const names = { paper: '文献', libraryProject: '文献项目', experiment: '实验' } as const
export interface PlanningHostPatch { libraryProjectId?: string | null; experimentIds?: string[]; paperId?: string | null }
interface Props {
  scope: PlanningScope; libraryProjectId: string | null; experimentIds: string[]; paperId?: string | null; disabled?: boolean; readOnly?: boolean
  onChange(patch: PlanningHostPatch): void; onOpen?(kind: PlanningHostKind, id: string): void
}
export function PlanningHostLinks({ scope, libraryProjectId, experimentIds, paperId, disabled, readOnly, onChange, onOpen }: Props) {
  const [picker, setPicker] = useState<PlanningHostKind | null>(null), [rows, setRows] = useState<{ kind: PlanningHostKind; ref: PlanningHostReference }[]>([]), [error, setError] = useState('')
  const signature = JSON.stringify({ libraryProjectId, experimentIds, paperId })
  useResearchBusy(picker !== null)
  useEffect(() => {
    let active = true
    setRows([]); setError('')
    void (async () => {
      try {
        const api = window.electronAPI?.researchPlanning
        if (typeof api?.references !== 'function') return
        const values = JSON.parse(signature) as Pick<Props, 'libraryProjectId' | 'experimentIds' | 'paperId'>
        const selected: [PlanningHostKind, string[]][] = [['libraryProject', values.libraryProjectId ? [values.libraryProjectId] : []], ['experiment', values.experimentIds], ['paper', values.paperId ? [values.paperId] : []]]
        const resolved: typeof rows = []
        for (const [kind, ids] of selected) for (let page = 1; page <= Math.ceil(ids.length / 50); page++) {
          const result = await api.references({ scope, kind, keyword: '', page, ids })
          if (!result.ok) throw Error(result.message)
          resolved.push(...result.items.map(ref => ({ kind, ref })))
        }
        if (active) setRows(resolved)
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : '关联读取失败，原标识保留') }
    })()
    return () => { active = false }
  }, [scope.workspaceId, scope.spaceEpoch, signature])
  function pick(kind: PlanningHostKind, id: string) {
    onChange(kind === 'paper' ? { paperId: id } : kind === 'libraryProject' ? { libraryProjectId: id } : { experimentIds: [...new Set([...experimentIds, id])] })
    setPicker(null)
  }
  return <fieldset className="space-y-2 rounded border border-border p-3"><legend className="text-sm">关联现有科研资料</legend><p className="text-xs text-muted-foreground">只建立标识关联；不导入PDF、不调用模型、不跨模块删除。</p>
    {rows.map(({ kind, ref }) => <div key={`${kind}/${ref.id}`} className="flex flex-wrap items-center gap-2 text-sm"><span>{names[kind]}：</span><span className={!ref.exists ? 'text-destructive' : ''}>{ref.name}</span>{onOpen && <Button type="button" size="sm" variant="outline" disabled={disabled || !ref.exists} onClick={() => onOpen(kind, ref.id)}>打开关联{names[kind]}</Button>}{!readOnly && <Button type="button" size="sm" variant="outline" aria-label={`移除关联${ref.name}`} disabled={disabled} onClick={() => onChange(kind === 'paper' ? { paperId: null } : kind === 'libraryProject' ? { libraryProjectId: null } : { experimentIds: experimentIds.filter(id => id !== ref.id) })}>移除关联</Button>}</div>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!readOnly && <div className="flex flex-wrap gap-2">{(['libraryProject', 'experiment', ...(paperId !== undefined ? ['paper' as const] : [])] as PlanningHostKind[]).map(kind => <Button type="button" key={kind} size="sm" variant="outline" disabled={disabled || kind === 'experiment' && experimentIds.length >= 200} onClick={() => setPicker(kind)}>选择{names[kind]}</Button>)}</div>}
    {picker && <HostPicker scope={scope} kind={picker} onPick={id => pick(picker, id)} onClose={() => setPicker(null)} />}
  </fieldset>
}
function HostPicker({ scope, kind, onPick, onClose }: { scope: PlanningScope; kind: PlanningHostKind; onPick(id: string): void; onClose(): void }) {
  const [keyword, setKeyword] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1), [total, setTotal] = useState(0), [rows, setRows] = useState<PlanningHostReference[]>([]), [busy, setBusy] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => { const timer = setTimeout(() => { setQuery(keyword); setPage(1) }, 200); return () => clearTimeout(timer) }, [keyword])
  useEffect(() => {
    let active = true
    setBusy(true); setError('')
    void (async () => {
      try {
        const result = await window.electronAPI!.researchPlanning.references({ scope, kind, keyword: query, page })
        if (!result.ok) throw Error(result.message)
        if (active) { setRows(result.items); setTotal(result.total) }
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : '关联列表不可用') }
      finally { if (active) setBusy(false) }
    })()
    return () => { active = false }
  }, [scope.workspaceId, scope.spaceEpoch, kind, query, page, retry])
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-h-[85vh] overflow-y-auto" onKeyDown={event => event.stopPropagation()}><DialogHeader><DialogTitle>选择{names[kind]}</DialogTitle><DialogDescription>仅当前科研空间，50项分页；选择只关联资料，不执行或下载。</DialogDescription></DialogHeader><input aria-label="搜索现有科研资料" className={researchControl} value={keyword} onChange={e => setKeyword(e.target.value)} />{error && <p role="alert" className="text-destructive">{error}</p>}{busy ? <p role="status">读取关联列表…</p> : rows.map(row => <Button type="button" variant="outline" className="h-auto justify-start whitespace-normal break-words" key={row.id} onClick={() => onPick(row.id)}>{row.name}</Button>)}{!busy && !error && rows.length === 0 && <p>没有匹配资料，请先在原模块创建。</p>}<div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页资料</Button><Button type="button" variant="outline" disabled={busy || page * 50 >= total} onClick={() => setPage(page + 1)}>下一页资料</Button>{error && <Button type="button" variant="outline" onClick={() => setRetry(retry + 1)}>重试资料列表</Button>}<Button type="button" variant="outline" onClick={onClose}>关闭资料选择</Button></div></DialogContent></Dialog>
}
