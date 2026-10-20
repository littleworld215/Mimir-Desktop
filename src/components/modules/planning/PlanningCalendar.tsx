import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { researchControl } from '../library/research/useResearchForm'
import { addCalendarDays, addCalendarMonths, calendarRange, localPlanningDate } from '../../../../shared/researchPlanningDates'
import type { PlanningSummaryItem } from '../../../../shared/researchPlanningContracts'

export type CalendarMode = 'week-grid' | 'week-list' | 'month'
export interface CalendarDay { date: string; total: number; items: PlanningSummaryItem[] }
interface Props {
  anchor: string; mode: CalendarMode; days: CalendarDay[]; selected: string | null; busy: boolean
  onChange(anchor: string, mode: CalendarMode): void; onSelect(date: string | null): void; onCreate(date: string): void; onOpen(id: string): void
}
export function PlanningCalendar({ anchor, mode, days, selected, busy, onChange, onSelect, onCreate, onOpen }: Props) {
  const [error, setError] = useState('')
  function change(nextAnchor: string, nextMode: CalendarMode) {
    try {
      calendarRange(nextAnchor, nextMode === 'month' ? 'month' : 'week')
      onChange(nextAnchor, nextMode)
      setError('')
    } catch { setError('日期超出支持范围，请选择其他日期') }
  }
  function move(amount: number) { try { change(mode === 'month' ? addCalendarMonths(anchor, amount) : addCalendarDays(anchor, amount * 7), mode) } catch { setError('日期超出支持范围，请选择其他日期') } }
  return <section className="space-y-3" aria-label="科研日程日历">
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => move(-1)}>上一{mode === 'month' ? '月' : '周'}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => change(localPlanningDate(), mode)}>今天</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => move(1)}>下一{mode === 'month' ? '月' : '周'}</Button>
      <input aria-label="日历定位日期" type="date" className={`${researchControl} sm:max-w-48`} disabled={busy} value={anchor} onChange={e => { if (e.target.value) change(e.target.value, mode) }} />
      {([['week-grid', '周网格'], ['week-list', '周列表'], ['month', '月历']] as const).map(([id, label]) => <Button key={id} size="sm" variant={mode === id ? 'default' : 'outline'} disabled={busy} onClick={() => change(anchor, id)}>{label}</Button>)}
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <p className="text-xs text-muted-foreground">{days[0]?.date} 至 {days.at(-1)?.date} · 共{days.reduce((n, day) => n + day.total, 0)}项 · 日期按本地日历时间理解</p>
    {mode !== 'week-list' && <div className="grid grid-cols-7 gap-1 sm:gap-2">{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(day => <div key={day} className="min-w-0 text-center text-xs text-muted-foreground">{day}</div>)}{days.map(day => <div key={day.date} className={`min-w-0 space-y-1 rounded border p-1 sm:p-2 ${selected === day.date ? 'border-primary bg-accent' : 'border-border bg-card'}`}>
      <button type="button" className="w-full rounded text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`查看${day.date}日程`} disabled={busy} onClick={() => onSelect(day.date)}>{day.date.slice(5)}{day.date === localPlanningDate() ? ' · 今' : ''} <span className="text-muted-foreground">{day.total || ''}</span></button>
      {day.items.map(item => <button key={item.id} type="button" title={item.title} className="block w-full truncate rounded bg-accent px-1 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => onOpen(item.id)}>{item.schedule?.start ?? '全天'} {item.title}</button>)}
      {day.total > day.items.length && <button type="button" className="text-xs text-primary underline" disabled={busy} onClick={() => onSelect(day.date)}>另{day.total - day.items.length}项</button>}
      <button type="button" aria-label={`添加${day.date}日程`} className="text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => onCreate(day.date)}>＋日程</button>
    </div>)}</div>}
    {selected && <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium">日期详情：{selected}</h2><Button variant="outline" size="sm" disabled={busy} onClick={() => onSelect(null)}>返回整个日期范围</Button></div>}
  </section>
}
