import { z } from 'zod'
import { PLANNING_MAX_BYTES, PLANNING_MAX_ITEMS, type PlanningDocument, type PlanningDraftDocument, type PlanningDeliveryDocument, type PlanningErrorCode, type PlanningInput } from '../../shared/researchPlanningContracts'

export class PlanningError extends Error {
  constructor(readonly code: PlanningErrorCode, message = '操作未完成，原资料已保留', readonly currentRevision?: number) { super(`${code}: ${message}`) }
}
export const planningId = z.string().min(1).max(200).regex(/^[\p{L}\p{N}_:.-]+$/u)
export const planningRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const planningScopeSchema = z.object({ workspaceId: z.string().min(1).max(1000), spaceEpoch: z.string().min(1).max(1000) }).strict()
const kind = z.enum(['project', 'direction', 'todo', 'schedule', 'generic', 'literature'])
export const planningDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const date = new Date(`${v}T12:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v }, '日历日期不存在')
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const timestamp = z.string().datetime()
const field = z.object({ id: planningId, name: z.string().max(200), value: z.string().max(16_000) }).strict()
export const planningInputSchema = z.object({
  kind, typeId: planningId, collectionId: planningId, title: z.string().min(1).max(500).refine(v => v.trim().length > 0), content: z.string().max(100_000),
  status: z.enum(['planned', 'active', 'paused', 'done']), important: z.boolean(), archived: z.boolean(), deleted: z.boolean(), priority: z.enum(['none', 'low', 'medium', 'high']),
  order: z.number().finite(), fields: z.array(field).max(50).refine(v => new Set(v.map(f => f.id)).size === v.length),
  projectId: planningId.nullable(), directionId: planningId.nullable(), projectCategory: z.enum(['vertical', 'horizontal', 'other']).nullable(), majorDirection: z.boolean(),
  done: z.boolean(), dueDate: planningDate.nullable(), myDay: planningDate.nullable(),
  schedule: z.object({ date: planningDate, start: time.nullable(), end: time.nullable() }).strict().refine(s => (s.start === null && s.end === null) || (s.start !== null && s.end !== null && s.start < s.end), '起止时间须成对且结束晚于开始').nullable(),
  recurrence: z.object({ unit: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(99) }).strict().nullable(),
  literature: z.object({ authors: z.array(z.string().max(500)).max(200), year: z.number().int().min(1).max(9999).nullable(), doi: z.string().max(2000), url: z.string().max(4000), readingState: z.enum(['unread', 'reading', 'read']), paperId: z.string().min(1).max(1000).nullable() }).strict().nullable(),
  libraryProjectId: z.string().min(1).max(1000).nullable(), experimentIds: z.array(z.string().min(1).max(1000)).max(200).refine(v => new Set(v).size === v.length)
}).strict()
function assertKind(input: PlanningInput) {
  if ((input.schedule !== null && input.kind !== 'schedule') || (input.recurrence !== null && (input.kind !== 'todo' || input.dueDate === null)) || (input.literature !== null && input.kind !== 'literature') || (input.projectCategory !== null && input.kind !== 'project') || (input.majorDirection && input.kind !== 'direction')) throw new PlanningError('BAD_REQUEST', '字段不适用于该记录类型')
}
const item = planningInputSchema.extend({ id: planningId, createdAt: timestamp, updatedAt: timestamp })
const collection = z.object({ id: planningId, name: z.string().min(1).max(200), order: z.number().finite(), deleted: z.boolean() }).strict()
const definition = z.object({ id: planningId, name: z.string().min(1).max(200), kind, builtin: z.boolean(), order: z.number().finite(), deleted: z.boolean() }).strict()
const document = z.object({ schemaVersion: z.literal(1), revision: planningRevision, collections: z.array(collection).min(1).max(200), types: z.array(definition).min(1).max(200), items: z.array(item).max(PLANNING_MAX_ITEMS) }).strict()
function unique(values: { id: string }[]) { if (new Set(values.map(v => v.id)).size !== values.length) throw new PlanningError('CORRUPT_DATA', '标识重复') }
function version(value: unknown) { if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new PlanningError('UNSUPPORTED_VERSION', '格式版本不支持，请保留原文件') }
export function assertPlanningBytes(length: number) { if (length > PLANNING_MAX_BYTES) throw new PlanningError('LIMIT_EXCEEDED', '数据超过16MiB，未截断或覆盖') }
export function parsePlanningInput(value: unknown): PlanningInput {
  const result = planningInputSchema.safeParse(value)
  if (!result.success) throw new PlanningError('BAD_REQUEST', '记录字段非法或超限')
  assertKind(result.data)
  return result.data
}
export function parsePlanningDocument(value: unknown): PlanningDocument {
  version(value)
  const result = document.safeParse(value)
  if (!result.success) throw new PlanningError('CORRUPT_DATA', '科研计划结构非法，原文件已保留')
  const doc = result.data
  unique(doc.collections); unique(doc.types); unique(doc.items)
  const collections = new Map(doc.collections.map(v => [v.id, v])), types = new Map(doc.types.map(v => [v.id, v])), items = new Map(doc.items.map(v => [v.id, v]))
  for (const value of doc.items) {
    assertKind(value)
    const definition = types.get(value.typeId), group = collections.get(value.collectionId)
    if (!definition || !group || definition.kind !== value.kind) throw new PlanningError('CORRUPT_DATA', '分组或类型关联无效')
    for (const [id, targetKind] of [[value.projectId, 'project'], [value.directionId, 'direction']] as const) {
      if (id !== null && (id === value.id || items.get(id)?.kind !== targetKind)) throw new PlanningError('CORRUPT_DATA', '计划关联目标不存在或类型不符')
    }
    if (!value.deleted && (definition.deleted || group.deleted)) throw new PlanningError('CORRUPT_DATA', '有效记录仍属于已删除分组或类型')
  }
  return doc
}
export { emptyPlanningDocument, emptyPlanningInput } from '../../shared/researchPlanningDefaults'
export function parsePlanningDrafts(value: unknown): PlanningDraftDocument {
  version(value)
  // 草稿是尚未完成的表单，不能套用正式保存的必填标题、起止时间配对约束。
  const draftInput = planningInputSchema.extend({ title: z.string().max(500), schedule: z.object({ date: planningDate, start: time.nullable(), end: time.nullable() }).strict().nullable() })
  const parsed = z.object({ schemaVersion: z.literal(1), revision: planningRevision, drafts: z.array(z.object({ id: planningId, itemId: planningId.nullable(), baseRevision: planningRevision, input: draftInput, updatedAt: timestamp }).strict()).max(200) }).strict().safeParse(value)
  if (!parsed.success) throw new PlanningError('CORRUPT_DATA', '编辑草稿不可读，原文件保留')
  unique(parsed.data.drafts)
  return parsed.data
}
export function parsePlanningDeliveries(value: unknown): PlanningDeliveryDocument {
  version(value)
  const parsed = z.object({ schemaVersion: z.literal(1), revision: planningRevision, deliveries: z.array(z.object({ itemId: planningId, dueDate: planningDate, deliveredAt: timestamp }).strict()).max(100_000) }).strict().safeParse(value)
  if (!parsed.success || new Set(parsed.data.deliveries.map(d => `${d.itemId}/${d.dueDate}`)).size !== parsed.data.deliveries.length) throw new PlanningError('CORRUPT_DATA', '提醒记录不可读，原文件保留')
  return parsed.data
}
