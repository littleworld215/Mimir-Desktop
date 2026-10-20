import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PlanningDocument, PlanningCommand } from '../../shared/researchPlanningContracts'
import { planningDate, planningId, PlanningError } from './validation'
import { appendRecurringSuccessor } from './recurrence'
import { localPlanningDate } from '../../shared/researchPlanningDates'

const ids = z.array(planningId).min(1).max(1000).refine(v => new Set(v).size === v.length)
const name = z.string().min(1).max(200).refine(v => v.trim().length > 0)
export const planningCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('collection'), id: planningId.optional(), name, deleted: z.boolean().optional(), moveTo: planningId.optional() }).strict(),
  z.object({ kind: z.literal('type'), id: planningId.optional(), name, itemKind: z.enum(['generic', 'todo']).optional(), deleted: z.boolean().optional(), moveTo: planningId.optional() }).strict(),
  z.object({ kind: z.literal('bulk'), ids, patch: z.object({ archived: z.boolean().optional(), deleted: z.boolean().optional(), collectionId: planningId.optional(), status: z.enum(['planned', 'active', 'paused', 'done']).optional(), important: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0) }).strict(),
  z.object({ kind: z.literal('duplicate'), id: planningId }).strict(), z.object({ kind: z.literal('reorder'), ids }).strict(), z.object({ kind: z.literal('clearCompleted'), collectionId: planningId.optional(), typeId: planningId.optional() }).strict(),
  z.object({ kind: z.literal('completeTodo'), id: planningId, done: z.boolean() }).strict(),
  z.object({ kind: z.literal('planTodoDay'), id: planningId, date: planningDate.nullable() }).strict()
])
/** 先在分离副本上计算，预览不写盘；任何目标无效时整体拒绝。 */
export function applyPlanningCommand(previous: PlanningDocument, raw: PlanningCommand, today = localPlanningDate()) {
  const parsed = planningCommandSchema.safeParse(raw)
  if (!parsed.success) throw new PlanningError('BAD_REQUEST', '批量或管理请求非法')
  const command = parsed.data, doc = structuredClone(previous), now = new Date().toISOString()
  let entityId: string | undefined, affectedCount = 0
  if (command.kind === 'collection') {
    const old = command.id ? doc.collections.find(c => c.id === command.id) : undefined
    if (command.id && !old || old?.id === 'default' && command.deleted) throw new PlanningError('BAD_REQUEST', '默认分组不可删除或分组不存在')
    if (old) {
      if (command.deleted) {
        if (!command.moveTo || command.moveTo === old.id || !doc.collections.some(c => c.id === command.moveTo && !c.deleted)) throw new PlanningError('BAD_REQUEST', '请选择迁移目标分组')
        for (const item of doc.items) if (item.collectionId === old.id) { item.collectionId = command.moveTo; item.updatedAt = now; affectedCount++ }
      }
      old.name = command.name; old.deleted = command.deleted ?? old.deleted; entityId = old.id
    } else { entityId = randomUUID(); doc.collections.push({ id: entityId, name: command.name, order: doc.collections.length, deleted: false }) }
  } else if (command.kind === 'type') {
    const old = command.id ? doc.types.find(t => t.id === command.id) : undefined
    if (command.id && !old || old?.builtin && command.deleted) throw new PlanningError('BAD_REQUEST', '内置类型不可删除或类型不存在')
    if (old) {
      if (command.itemKind && command.itemKind !== old.kind) throw new PlanningError('BAD_REQUEST', '类型语义不可变更')
      if (command.deleted) {
        const target = doc.types.find(t => t.id === command.moveTo && !t.deleted && t.kind === old.kind && t.id !== old.id)
        if (!target) throw new PlanningError('BAD_REQUEST', '请选择同种记录类型作为迁移目标')
        for (const item of doc.items) if (item.typeId === old.id) { item.typeId = target.id; item.updatedAt = now; affectedCount++ }
      }
      old.name = command.name; old.deleted = command.deleted ?? old.deleted; entityId = old.id
    } else { entityId = randomUUID(); doc.types.push({ id: entityId, name: command.name, kind: command.itemKind ?? 'generic', builtin: false, order: doc.types.length, deleted: false }) }
  } else if (command.kind === 'duplicate') {
    const original = doc.items.find(i => i.id === command.id && !i.deleted)
    if (!original) throw new PlanningError('NOT_FOUND')
    entityId = randomUUID()
    const { recurrenceParentId, ...copy } = original
    doc.items.push({ ...structuredClone(copy), id: entityId, title: `${original.title.slice(0, 490)}（副本）`, fields: original.fields.map(f => ({ ...f, id: randomUUID() })), done: false, status: original.kind === 'todo' ? 'active' : original.status, archived: false, deleted: false, createdAt: now, updatedAt: now })
    affectedCount = 1
  } else if (command.kind === 'clearCompleted') {
    for (const item of doc.items) if (item.kind === 'todo' && item.done && !item.archived && !item.deleted && (!command.collectionId || item.collectionId === command.collectionId) && (!command.typeId || item.typeId === command.typeId)) { item.deleted = true; item.updatedAt = now; affectedCount++ }
  } else if (command.kind === 'completeTodo' || command.kind === 'planTodoDay') {
    const item = doc.items.find(i => i.id === command.id && i.kind === 'todo' && !i.deleted)
    if (!item) throw new PlanningError('NOT_FOUND', '待办不存在')
    const before = { ...item }
    if (command.kind === 'completeTodo') { item.done = command.done; item.status = command.done ? 'done' : 'active'; appendRecurringSuccessor(doc, before, item, today) }
    else item.myDay = command.date
    item.updatedAt = now; affectedCount = 1
  } else {
    const selected = command.ids.map(id => doc.items.find(i => i.id === id))
    if (selected.some(v => !v)) throw new PlanningError('NOT_FOUND', '部分记录不存在，未执行批量操作')
    if (command.kind === 'bulk') {
      if (command.patch.collectionId && !doc.collections.some(c => c.id === command.patch.collectionId && !c.deleted)) throw new PlanningError('BAD_REQUEST', '目标分组不可用')
      selected.forEach(item => { const before = { ...item! }; Object.assign(item!, command.patch, { updatedAt: now }); if (item!.kind === 'todo' && command.patch.status) { item!.done = command.patch.status === 'done'; appendRecurringSuccessor(doc, before, item!, today) }; affectedCount++ })
    } else {
      if (selected.some(i => i!.deleted || i!.typeId !== selected[0]!.typeId)) throw new PlanningError('BAD_REQUEST', '只能对同类型有效记录排序')
      const siblings = doc.items.filter(i => i.typeId === selected[0]!.typeId && !i.deleted).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      const chosen = new Set(command.ids), positions = siblings.map((i, at) => chosen.has(i.id) ? at : -1).filter(at => at >= 0)
      selected.forEach((item, at) => { siblings[positions[at]!] = item! })
      siblings.forEach((item, order) => { item.order = order; item.updatedAt = now }); affectedCount = selected.length
    }
  }
  doc.revision++
  return { document: doc, entityId, affectedCount }
}
