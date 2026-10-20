import type { PlanningDocument, PlanningFilter, PlanningItem, PlanningSummary, PlanningSummaryItem } from '../../shared/researchPlanningContracts'
import { addCalendarDays, calendarRange } from '../../shared/researchPlanningDates'
import { PlanningError } from './validation'

const ranks = { high: 0, medium: 1, low: 2, none: 3 }
export const todoOrder = (a: PlanningItem, b: PlanningItem) => ranks[a.priority] - ranks[b.priority] || (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || a.order - b.order || a.id.localeCompare(b.id)
export const eventOrder = (a: PlanningItem, b: PlanningItem) => (a.schedule?.date ?? '').localeCompare(b.schedule?.date ?? '') || (a.schedule?.start ?? '').localeCompare(b.schedule?.start ?? '') || a.order - b.order || a.id.localeCompare(b.id)
const compact = (i: PlanningItem): PlanningSummaryItem => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, done: i.done, priority: i.priority, important: i.important, projectId: i.projectId, dueDate: i.dueDate, myDay: i.myDay, schedule: i.schedule })
/** 列表和日历共用筛选语义，避免计数混入其它分组或遗漏归档项。 */
export function filterPlanningItems(items: PlanningItem[], filter: PlanningFilter) {
  const keyword = filter.keyword?.toLocaleLowerCase(), archive = filter.archived ?? 'exclude'
  return items.filter(item => {
    if (item.deleted !== (filter.deleted ?? false)) return false
    if (archive === 'exclude' && item.archived || archive === 'only' && !item.archived) return false
    for (const key of ['kind', 'typeId', 'collectionId', 'projectId', 'status', 'important', 'done', 'myDay', 'priority'] as const) if (filter[key] !== undefined && item[key] !== filter[key]) return false
    if (filter.dueBefore && (!item.dueDate || item.dueDate >= filter.dueBefore)) return false
    const date = item.schedule?.date
    if (filter.dateFrom && (!date || date < filter.dateFrom) || filter.dateTo && (!date || date > filter.dateTo)) return false
    return !keyword || [item.title, item.content, ...item.fields.flatMap(f => [f.name, f.value])].some(value => value.toLocaleLowerCase().includes(keyword))
  })
}
export function planningItemOrder(a: PlanningItem, b: PlanningItem) {
  const kinds = { project: 0, direction: 1, todo: 2, schedule: 3, generic: 4, literature: 5 }
  if (a.kind !== b.kind) return kinds[a.kind] - kinds[b.kind]
  if (a.kind === 'schedule') return eventOrder(a, b)
  if (a.kind === 'todo') return todoOrder(a, b)
  return (a.kind === 'direction' ? Number(b.majorDirection) - Number(a.majorDirection) : 0) || a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}
export function planningSummary(doc: PlanningDocument, date: string, projectIds?: string[]): PlanningSummary {
  const active = doc.items.filter(i => !i.archived && !i.deleted), todos = active.filter(i => i.kind === 'todo' && !i.done).sort(todoOrder)
  const myDay = todos.filter(i => i.myDay === date), overdue = todos.filter(i => i.dueDate !== null && i.dueDate < date), week = calendarRange(date, 'week')
  const weekEvents = active.filter(i => i.kind === 'schedule' && i.schedule && i.schedule.date >= week.from && i.schedule.date <= week.to).sort(eventOrder)
  const activeProjects = active.filter(i => i.kind === 'project' && i.status === 'active').sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const selected = projectIds ?? activeProjects.slice(0, 5).map(i => i.id)
  const nextActions: Record<string, PlanningSummaryItem[]> = Object.create(null)
  selected.forEach(id => { nextActions[id] = todos.filter(i => i.projectId === id).slice(0, 3).map(compact) })
  return { counts: { myDay: myDay.length, overdue: overdue.length, weekEvents: weekEvents.length, activeProjects: activeProjects.length }, myDay: myDay.slice(0, 5).map(compact), overdue: overdue.slice(0, 5).map(compact), weekEvents: weekEvents.slice(0, 5).map(compact), activeProjects: activeProjects.slice(0, 5).map(compact), nextActions }
}
export function planningCalendar(doc: PlanningDocument, from: string, to: string, filter: PlanningFilter = {}) {
  if (from > to || addCalendarDays(from, 41) < to) throw new PlanningError('BAD_REQUEST', '一次最多查询42天日程')
  const events = filterPlanningItems(doc.items, { ...filter, kind: 'schedule', dateFrom: from, dateTo: to }).filter(i => i.schedule !== null).sort(eventOrder)
  const buckets = new Map<string, PlanningItem[]>()
  for (const item of events) { const day = item.schedule!.date; const bucket = buckets.get(day) ?? []; bucket.push(item); buckets.set(day, bucket) }
  const days = []
  for (let day = from; day <= to; day = addCalendarDays(day, 1)) { const items = buckets.get(day) ?? []; days.push({ date: day, total: items.length, items: items.slice(0, 3).map(compact) }) }
  return { total: events.length, days }
}
