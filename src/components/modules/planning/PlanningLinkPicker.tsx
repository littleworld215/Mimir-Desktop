import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { researchControl } from '../library/research/useResearchForm'
import type { PlanningItem, PlanningScope } from '../../../../shared/researchPlanningContracts'

export function PlanningReferenceName({ scope, id }: { scope: PlanningScope; id: string | null }) {
  const [label, setLabel] = useState(id ? '读取关联…' : '未关联')
  useEffect(() => {
    let active = true
    if (!id) { setLabel('未关联'); return }
    setLabel('读取关联…')
    void (async () => {
      try {
        const api = window.electronAPI?.researchPlanning
        if (!api) throw Error('interface')
        const result = await api.detail({ scope, itemId: id })
        if (!result.ok) throw Error(result.message)
        if (active) setLabel(`${result.item.title}${result.item.deleted ? '（已移入回收站）' : result.item.archived ? '（已归档）' : ''}`)
      } catch { if (active) setLabel('关联不可用，可清除或重新选择') }
    })()
    return () => { active = false }
  }, [scope.workspaceId, scope.spaceEpoch, id])
  return <span>{label}</span>
}

export function PlanningLinkPicker({ scope, kind, onPick, onClose }: { scope: PlanningScope; kind: 'project' | 'direction'; onPick(id: string): void; onClose(): void }) {
  const [keyword, setKeyword] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1), [items, setItems] = useState<PlanningItem[]>([]), [total, setTotal] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(true), [retry, setRetry] = useState(0)
  const sequence = useRef(0)
  useEffect(() => { const timer = setTimeout(() => { setQuery(keyword); setPage(1) }, 200); return () => clearTimeout(timer) }, [keyword])
  useEffect(() => {
    const request = ++sequence.current
    setBusy(true); setError('')
    void (async () => {
      try {
        const api = window.electronAPI?.researchPlanning
        if (!api) throw Error('科研计划接口不可用')
        const result = await api.list({ scope, filter: { kind, keyword: query, archived: 'exclude', deleted: false }, page })
        if (request !== sequence.current) return
        if (!result.ok) throw Error(result.message)
        setItems(result.items); setTotal(result.total)
      } catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : '关联列表加载失败') }
      finally { if (request === sequence.current) setBusy(false) }
    })()
    return () => { sequence.current++ }
  }, [scope.workspaceId, scope.spaceEpoch, kind, query, page, retry])
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>选择关联{kind === 'project' ? '科研项目' : '研究方向'}</DialogTitle><DialogDescription>只显示当前科研空间中的有效记录，支持搜索和分页。</DialogDescription></DialogHeader>
    <input aria-label="搜索关联记录" className={researchControl} value={keyword} onChange={e => setKeyword(e.target.value)} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {busy ? <p role="status">加载关联记录…</p> : <div className="space-y-2">{items.map(item => <Button className="h-auto w-full justify-start whitespace-normal break-words" variant="outline" type="button" key={item.id} onClick={() => { onPick(item.id); onClose() }}>{item.title}</Button>)}{items.length === 0 && <p className="text-sm text-muted-foreground">没有匹配记录，可先创建后再关联。</p>}</div>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页关联</Button><Button type="button" variant="outline" disabled={busy || page * 50 >= total} onClick={() => setPage(page + 1)}>下一页关联</Button>{error && <Button type="button" variant="outline" onClick={() => setRetry(retry + 1)}>重试关联列表</Button>}<Button type="button" variant="outline" onClick={onClose}>关闭选择</Button></div>
  </DialogContent></Dialog>
}
