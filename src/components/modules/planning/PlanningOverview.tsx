import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ModuleId } from '@/components/layout/Sidebar'
import { rememberPlanningIntent, type PlanningIntent } from '@/lib/planningNavigation'
import { localPlanningDate } from '../../../../shared/researchPlanningDates'
import { usePlanningToday } from '@/lib/usePlanningToday'
import type { PlanningScope, PlanningSummary } from '../../../../shared/researchPlanningContracts'

export function PlanningOverview({ onNavigate }: { onNavigate(id: ModuleId): void }) {
  const today = usePlanningToday()
  const [summary, setSummary] = useState<PlanningSummary | null>(null), [scope, setScope] = useState<PlanningScope | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const request = useRef(0)
  useEffect(() => {
    const current = ++request.current
    void (async () => {
      try {
        const api = window.electronAPI?.researchPlanning
        if (!api) throw Error('科研计划桌面接口不可用，请使用新版桌面工作台')
        const boot = await api.bootstrap({})
        if (!boot.ok) throw Error(boot.message)
        if (request.current !== current) return
        const result = await api.summary({ scope: boot.scope, date: today })
        if (!result.ok) throw Error(result.message)
        if (request.current === current) { setSummary(result); setScope(result.scope); setError('') }
      } catch (failure) { if (request.current === current) setError(failure instanceof Error ? failure.message : '计划摘要不可用') }
    })()
    return () => { request.current++ }
  }, [retry, today])
  function open(intent: Omit<PlanningIntent, 'workspaceId'>) { if (scope) rememberPlanningIntent({ ...intent, workspaceId: scope.workspaceId }); onNavigate('planning') }
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="科研计划摘要"><h2 className="font-medium">科研计划</h2>
    {error ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => setRetry(retry + 1)}>重试科研计划摘要</Button></div> : summary ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{([
      { title: '今日待办', count: summary.counts.myDay, items: summary.myDay, kind: 'todo', todoView: 'today' },
      { title: '逾期待办', count: summary.counts.overdue, items: summary.overdue, kind: 'todo', todoView: 'overdue' },
      { title: '本周日程', count: summary.counts.weekEvents, items: summary.weekEvents, kind: 'schedule' },
      { title: '活跃科研项目', count: summary.counts.activeProjects, items: summary.activeProjects, kind: 'project' }
    ] as const).map(group => <div key={group.title} className="min-w-0 space-y-2 rounded border border-border p-3"><Button size="sm" variant="outline" onClick={() => open({ kind: group.kind, ...('todoView' in group ? { todoView: group.todoView } : {}), date: localPlanningDate() })}>{group.title} {group.count}</Button><ul className="space-y-1 text-xs text-muted-foreground">{group.items.map(item => <li key={item.id} className="break-words">{item.title}{item.dueDate ? ` · ${item.dueDate}` : ''}{item.schedule ? ` · ${item.schedule.date} ${item.schedule.start ?? '全天'}` : ''}</li>)}{group.items.length === 0 && <li>暂无安排</li>}</ul>{group.count > group.items.length && <p className="text-xs text-muted-foreground">显示前{group.items.length}项</p>}</div>)}</div> : <p role="status" className="text-xs text-muted-foreground">正在读取科研计划摘要…</p>}
  </section>
}
