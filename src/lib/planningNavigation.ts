import type { PlanningKind } from '../../shared/researchPlanningContracts'
import { calendarRange } from '../../shared/researchPlanningDates'

export interface PlanningIntent { workspaceId: string; kind: PlanningKind; todoView?: 'today' | 'overdue' | 'all'; date?: string }
const key = 'mimir:planning-intent'
export function rememberPlanningIntent(intent: PlanningIntent) { try { sessionStorage.setItem(key, JSON.stringify(intent)) } catch { /* 导航仍可进入默认列表 */ } }
export function consumePlanningIntent(): PlanningIntent | null {
  try {
    const raw = sessionStorage.getItem(key); sessionStorage.removeItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PlanningIntent>
    if (typeof value.workspaceId !== 'string' || !['project', 'todo', 'schedule'].includes(value.kind ?? '') || value.todoView && !['today', 'overdue', 'all'].includes(value.todoView) || value.date && !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return null
    if (value.date) calendarRange(value.date, 'week')
    return value as PlanningIntent
  } catch { return null }
}
