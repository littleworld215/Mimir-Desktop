import { randomUUID } from 'node:crypto'
import type { PlanningDocument, PlanningItem } from '../../shared/researchPlanningContracts'
import { nextRecurringDate } from '../../shared/researchPlanningDates'
import { PlanningError } from './validation'

/** 同一父任务最多一条下一期；撤销完成不删除已生成的工作，也不允许重放生成。 */
export function appendRecurringSuccessor(document: PlanningDocument, previous: PlanningItem | undefined, item: PlanningItem, today: string) {
  if (!previous || previous.done || !item.done || item.kind !== 'todo' || !item.recurrence || !item.dueDate || document.items.some(v => v.recurrenceParentId === item.id)) return
  let dueDate: string
  try { dueDate = nextRecurringDate(item.dueDate, item.recurrence, today) } catch { throw new PlanningError('BAD_REQUEST', '下一期日期无法生成，请检查日期和重复规则') }
  const { id, createdAt, updatedAt, recurrenceParentId, ...input } = item
  const now = new Date().toISOString()
  document.items.push({ ...structuredClone(input), id: randomUUID(), dueDate, myDay: null, done: false, status: 'active', archived: false, deleted: false, fields: input.fields.map(f => ({ ...f, id: randomUUID() })), createdAt: now, updatedAt: now, recurrenceParentId: item.id })
}
