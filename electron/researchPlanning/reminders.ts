import { AsyncResource } from 'node:async_hooks'
import { localPlanningDate } from '../../shared/researchPlanningDates'
import type { PlanningItem, PlanningScope } from '../../shared/researchPlanningContracts'
import type { OperationScope } from '../workspaceBackup/operationGate'
import { createPlanningDeliveryRepository, createPlanningRepository } from './repository'
import type { PlanningRuntime } from './runtime'
import { PlanningError } from './validation'

export interface PlanningNotice { itemId: string; title: string; dueDate: string; onClick(): void }
interface Dependencies {
  runtime: PlanningRuntime; enabled(): boolean
  show(notice: PlanningNotice, signal: AbortSignal): Promise<boolean>; closeAll(): void
  open(scope: PlanningScope, itemId: string): void; today?(): string; now?(): Date
}
const eligible = (i: PlanningItem, today: string) => i.kind === 'todo' && !i.done && !i.archived && !i.deleted && i.dueDate !== null && i.dueDate <= today
const key = (id: string, date: string) => `${id}/${date}`
const same = (a: OperationScope, b: OperationScope) => a.id === b.id && a.epoch === b.epoch && a.root === b.root

/** Native producers start new leases, never reuse the lease which created a timer/notice. */
export function createPlanningReminders(deps: Dependencies) {
  const tasks = new AsyncResource('planning-reminder-producer'), repo = createPlanningRepository(), deliveries = createPlanningDeliveryRepository()
  let stopped = false, controller: AbortController | undefined, pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let stopping: Promise<void> | undefined
  let last = { checkedAt: null as string | null, delivered: 0, pending: 0, errorCode: null as string | null }
  const today = () => deps.today?.() ?? localPlanningDate(), now = () => (deps.now?.() ?? new Date()).toISOString()
  function click(scope: OperationScope, id: string) {
    if (stopped || !deps.enabled()) return
    void deps.runtime.runFresh(async ctx => {
      if (stopped || !deps.enabled() || !same(ctx.scope, scope)) return
      const item = repo.read(scope.root).items.find(i => i.id === id)
      ctx.assertCurrent()
      if (item && !item.deleted) deps.open({ workspaceId: scope.id, spaceEpoch: scope.epoch }, id)
    }).catch(() => { /* A stale notice may not switch spaces or revive stopped producers. */ })
  }
  function check(): Promise<void> {
    if (stopped || !deps.enabled()) return Promise.resolve()
    if (pending) return pending
    const active = new AbortController(); controller = active
    const operation = deps.runtime.runFresh(async ctx => {
      let delivered = 0, attempts = 0
      try {
        const doc = repo.read(ctx.scope.root), record = deliveries.read(ctx.scope.root), sent = new Set(record.deliveries.map(d => key(d.itemId, d.dueDate)))
        const candidates = doc.items.filter(i => eligible(i, today()) && !sent.has(key(i.id, i.dueDate!)))
        const groups = new Map<string, PlanningItem[]>(), lastType = new Map<string, string>(), items = new Map(doc.items.map(i => [i.id, i]))
        for (const entry of record.deliveries) { const type = items.get(entry.itemId)?.typeId; if (type && entry.deliveredAt > (lastType.get(type) ?? '')) lastType.set(type, entry.deliveredAt) }
        for (const i of candidates) { const group = groups.get(i.typeId) ?? []; group.push(i); groups.set(i.typeId, group) }
        const priority = { high: 0, medium: 1, low: 2, none: 3 }
        for (const list of groups.values()) list.sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || priority[a.priority] - priority[b.priority] || a.id.localeCompare(b.id))
        const types = [...groups.keys()].sort((a, b) => (lastType.get(a) ?? '').localeCompare(lastType.get(b) ?? '') || a.localeCompare(b))
        while (delivered < 5 && attempts < 20 && types.some(t => groups.get(t)!.length)) {
          for (const type of types) {
            if (delivered >= 5 || attempts >= 20) break
            const item = groups.get(type)!.shift(); if (!item) continue
            ctx.assertCurrent(); if (stopped || !deps.enabled()) throw new PlanningError('CANCELED')
            attempts++
            const shown = await deps.show({ itemId: item.id, title: item.title, dueDate: item.dueDate!, onClick: () => click({ ...ctx.scope }, item.id) }, active.signal)
            ctx.assertCurrent(); if (stopped || !deps.enabled()) throw new PlanningError('CANCELED')
            if (!shown) continue
            // Re-read after the native await: completion/edit during display is legitimate.
            const current = repo.read(ctx.scope.root).items.find(i => i.id === item.id)
            if (!current || !eligible(current, today()) || current.dueDate !== item.dueDate) continue
            const latest = deliveries.read(ctx.scope.root)
            if (!latest.deliveries.some(d => d.itemId === item.id && d.dueDate === item.dueDate)) {
              deliveries.commit(ctx.scope.root, latest.revision, { schemaVersion: 1, revision: latest.revision + 1, deliveries: [...latest.deliveries, { itemId: item.id, dueDate: item.dueDate!, deliveredAt: now() }] }, ctx.assertCurrent)
              delivered++
            }
          }
        }
        last = { checkedAt: now(), delivered, pending: Math.max(0, candidates.length - delivered), errorCode: attempts > delivered && candidates.length > delivered ? 'NOTIFICATION_PENDING' : null }
      } catch (error) {
        // Intentional abort is neutral only AFTER the real native work has settled.
        if (error instanceof PlanningError && error.code === 'CANCELED' && active.signal.aborted) return
        throw error
      }
    }, active).catch(error => { last = { ...last, errorCode: error instanceof PlanningError ? error.code : 'CHECK_FAILED' } })
    pending = operation.finally(() => { if (controller === active) controller = undefined; pending = undefined })
    return pending
  }
  function schedule(delay: number) {
    clearTimeout(timer)
    if (stopped || !deps.enabled()) return
    tasks.runInAsyncScope(() => {
      timer = setTimeout(() => {
        timer = undefined
        void (async () => { if (pending) await pending; await check(); schedule(15 * 60_000) })()
      }, delay)
      timer.unref?.()
    })
  }
  return {
    check,
    status: () => ({ ...last }),
    refresh() { clearTimeout(timer); controller?.abort(); last = { checkedAt: null, delivered: 0, pending: 0, errorCode: null }; deps.closeAll(); schedule(0) },
    stop(): Promise<void> {
      if (stopping) return stopping
      stopped = true; clearTimeout(timer); controller?.abort()
      stopping = (async () => { try { deps.closeAll() } finally { await pending; tasks.emitDestroy() } })()
      return stopping
    }
  }
}
