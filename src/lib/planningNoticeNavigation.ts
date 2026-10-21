import type { PlanningScope } from '../../shared/researchPlanningContracts'
import type { PlanningIntent } from './planningNavigation'

/** Recheck scope before and after potentially slow saves; a notice cannot switch spaces. */
export async function followPlanningNotice(target: unknown, deps: {
  bootstrap(): Promise<{ ok: boolean; scope?: PlanningScope }>; canLeave(): Promise<boolean>; open(intent: PlanningIntent): void
}) {
  if (!target || typeof target !== 'object') return false
  const value = target as { scope?: Partial<PlanningScope>; itemId?: unknown }
  if (typeof value.itemId !== 'string' || !/^[\p{L}\p{N}_:.-]{1,200}$/u.test(value.itemId) || typeof value.scope?.workspaceId !== 'string' || typeof value.scope.spaceEpoch !== 'string') return false
  const { workspaceId, spaceEpoch } = value.scope
  if (!workspaceId || !spaceEpoch || workspaceId.length > 1000 || spaceEpoch.length > 1000) return false
  const matches = (state: { ok: boolean; scope?: PlanningScope }) => state.ok && state.scope?.workspaceId === workspaceId && state.scope.spaceEpoch === spaceEpoch
  if (!matches(await deps.bootstrap()) || !await deps.canLeave() || !matches(await deps.bootstrap())) return false
  deps.open({ workspaceId, spaceEpoch, itemId: value.itemId, kind: 'todo', todoView: 'all' })
  return true
}
