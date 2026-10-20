import type { PlanningHostKind, PlanningScope } from '../../shared/researchPlanningContracts'

export interface PlanningHostIntent { scope: PlanningScope; kind: PlanningHostKind; id: string }
const key = 'mimir:planning-host-intent'
export function rememberPlanningHostIntent(intent: PlanningHostIntent) { sessionStorage.setItem(key, JSON.stringify(intent)) }
export function consumePlanningHostIntent(module: 'library' | 'experiments'): PlanningHostIntent | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const intent = JSON.parse(raw) as PlanningHostIntent
    if (!['paper', 'libraryProject', 'experiment'].includes(intent.kind) || typeof intent.id !== 'string' || !intent.id || intent.id.length > 1000 || typeof intent.scope?.workspaceId !== 'string' || typeof intent.scope.spaceEpoch !== 'string') { sessionStorage.removeItem(key); return null }
    if ((intent.kind === 'experiment' ? 'experiments' : 'library') !== module) return null
    sessionStorage.removeItem(key)
    return intent
  } catch { sessionStorage.removeItem(key); return null }
}
export const samePlanningHostScope = (a: PlanningScope, b: PlanningScope) => a.workspaceId === b.workspaceId && a.spaceEpoch === b.spaceEpoch
