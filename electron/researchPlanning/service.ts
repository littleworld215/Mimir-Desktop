import { randomUUID } from 'node:crypto'
import { PLANNING_PAGE_SIZE, type PlanningCommand, type PlanningFilter, type PlanningItem } from '../../shared/researchPlanningContracts'
import { createPlanningRepository } from './repository'
import { parsePlanningDocument, parsePlanningInput, PlanningError } from './validation'
import { applyPlanningCommand } from './mutations'
import { appendRecurringSuccessor } from './recurrence'
import { filterPlanningItems, planningCalendar, planningItemOrder, planningSummary } from './views'
import { localPlanningDate } from '../../shared/researchPlanningDates'

export interface PlanningContext { scope: { id: string; epoch: string; root: string }; assertCurrent(): void; today?(): string }
export function createPlanningService(ctx: PlanningContext) {
  const repo = createPlanningRepository()
  const read = () => { ctx.assertCurrent(); return repo.read(ctx.scope.root) }
  const state = (revision: number) => ({ revision, scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch } })
  const today = () => ctx.today?.() ?? localPlanningDate()
  return {
    bootstrap() { const doc = read(); return { ...state(doc.revision), collections: doc.collections, types: doc.types, total: doc.items.filter(i => !i.deleted).length } },
    list(filter: PlanningFilter, page: number) {
      if (!Number.isSafeInteger(page) || page < 1) throw new PlanningError('BAD_REQUEST', '页码非法')
      const doc = read(), items = filterPlanningItems(doc.items, filter).sort(planningItemOrder)
      return { ...state(doc.revision), items: items.slice((page - 1) * PLANNING_PAGE_SIZE, page * PLANNING_PAGE_SIZE), total: items.length, page, pageSize: PLANNING_PAGE_SIZE }
    },
    summary(date: string, projectIds?: string[]) { const doc = read(); return { ...state(doc.revision), ...planningSummary(doc, date, projectIds) } },
    calendar(from: string, to: string, filter?: PlanningFilter) { const doc = read(); return { ...state(doc.revision), ...planningCalendar(doc, from, to, filter) } },
    detail(id: string) { const doc = read(), item = doc.items.find(i => i.id === id); if (!item) throw new PlanningError('NOT_FOUND', '记录不存在'); return { ...state(doc.revision), item } },
    mutate(expectedRevision: number, command: PlanningCommand, preview = false) {
      const doc = read()
      if (expectedRevision !== doc.revision) throw new PlanningError('CONFLICT', '已有更新，请重新预览', doc.revision)
      const next = applyPlanningCommand(doc, command, today())
      parsePlanningDocument(next.document)
      if (!preview) repo.commit(ctx.scope.root, expectedRevision, next.document, () => ctx.assertCurrent())
      return { ...state(preview ? doc.revision : next.document.revision), entityId: next.entityId, affectedCount: next.affectedCount, preview }
    },
    save(expectedRevision: number, value: unknown, id?: string) {
      const doc = read()
      if (expectedRevision !== doc.revision) throw new PlanningError('CONFLICT', '已有更新，请保留输入并重新加载', doc.revision)
      const input = parsePlanningInput(value), previous = id === undefined ? undefined : doc.items.find(i => i.id === id)
      if (id !== undefined && !previous) throw new PlanningError('NOT_FOUND', '记录不存在')
      const now = new Date().toISOString(), item: PlanningItem = { ...input, ...(input.kind === 'todo' ? { status: input.done ? 'done' as const : input.status === 'done' ? 'active' as const : input.status } : {}), id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now, ...(previous?.recurrenceParentId ? { recurrenceParentId: previous.recurrenceParentId } : {}) }
      const items = previous ? doc.items.map(i => i.id === item.id ? item : i) : [...doc.items, item]
      const document = { ...doc, revision: doc.revision + 1, items }
      appendRecurringSuccessor(document, previous, item, today())
      const next = repo.commit(ctx.scope.root, expectedRevision, document, () => ctx.assertCurrent())
      return { ...state(next.revision), item }
    }
  }
}
