import { z } from 'zod'
import type { EditingDocument, EditingErrorCode } from '../../shared/libraryEditingContracts'
export const EDITING_ENTRY_BYTES = 2 * 1024 * 1024
export const EDITING_MAX_BYTES = 32 * 1024 * 1024
export const EDITING_MAX_DRAFTS = 1000
export class EditingError extends Error {
  constructor(readonly code: EditingErrorCode, message = '操作未完成，原内容已保留') { super(`${code}: ${message}`) }
}
export const editingRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const editingId = z.string().uuid()
export const editingPaperId = z.string().min(1).max(1000).refine(v => !/[\u0000-\u001f]/.test(v))
export const editingScopeSchema = z.object({ workspaceId: z.string().min(1).max(1000), spaceEpoch: z.string().min(1).max(1000) }).strict()
export const editingKindSchema = z.enum(['notes', 'tags', 'append'])
export const editingFieldsSchema = z.object({ notes: z.string().optional(), tags: z.array(z.string()).optional() }).strict().refine(v => v.notes !== undefined || v.tags !== undefined)
const intentSchema = z.object({ commitId: editingId, draftIds: z.array(editingId).min(1).max(2), base: editingFieldsSchema, result: editingFieldsSchema, preparedAt: z.string().datetime() }).strict()
const draftSchema = z.object({ id: editingId, paperId: editingPaperId, kind: editingKindSchema, base: editingFieldsSchema, input: z.string(), revision: editingRevision.refine(v => v > 0), updatedAt: z.string().datetime(), intent: intentSchema.optional() }).strict()
const documentSchema = z.object({ schemaVersion: z.literal(1), revision: editingRevision, drafts: z.array(draftSchema) }).strict()
export function assertEditingBytes(size: number) { if (!Number.isSafeInteger(size) || size < 0 || size > EDITING_MAX_BYTES) throw new EditingError('LIMIT_EXCEEDED', '恢复草稿超过32MiB，未截断或覆盖') }
function bytes(value: unknown) {
  try { const text = JSON.stringify(value); if (text === undefined) throw Error(); return Buffer.byteLength(text, 'utf8') }
  catch { throw new EditingError('CORRUPT_DATA', '恢复草稿不能序列化') }
}
export function parseEditingDocument(value: unknown): EditingDocument {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new EditingError('UNSUPPORTED_VERSION', '恢复草稿版本不支持，原文件保留')
  assertEditingBytes(bytes(value))
  if (value && typeof value === 'object' && 'drafts' in value && Array.isArray(value.drafts) && value.drafts.length > EDITING_MAX_DRAFTS) throw new EditingError('LIMIT_EXCEEDED', '恢复草稿超过1000条，未自动删除')
  const parsed = documentSchema.safeParse(value)
  if (!parsed.success) throw new EditingError('CORRUPT_DATA', '恢复草稿结构非法，原文件保留')
  const doc = parsed.data
  const rows = new Map(doc.drafts.map(d => [d.id, d]))
  if (rows.size !== doc.drafts.length) throw new EditingError('CORRUPT_DATA', '恢复草稿标识重复')
  for (const row of doc.drafts) {
    if (bytes(row) > EDITING_ENTRY_BYTES) throw new EditingError('LIMIT_EXCEEDED', '单条恢复草稿超过2MiB，输入未截断')
    if (row.revision > doc.revision || (row.kind === 'tags' ? row.base.tags === undefined || row.base.notes !== undefined : row.base.notes === undefined || row.base.tags !== undefined)) throw new EditingError('CORRUPT_DATA', '恢复草稿基线或修订不匹配')
    const intent = row.intent
    if (!intent) continue
    const members = intent.draftIds.map(id => rows.get(id))
    if (!intent.draftIds.includes(row.id) || new Set(intent.draftIds).size !== members.length || members.some(d => !d || d.paperId !== row.paperId || JSON.stringify(d.intent) !== JSON.stringify(intent))) throw new EditingError('CORRUPT_DATA', '恢复草稿提交组不完整')
    const group = members as typeof doc.drafts
    const fields = group.map(d => d.kind === 'tags' ? 'tags' : 'notes')
    if (new Set(fields).size !== fields.length || JSON.stringify(Object.keys(intent.base).sort()) !== JSON.stringify(fields.slice().sort()) || JSON.stringify(Object.keys(intent.result).sort()) !== JSON.stringify(fields.slice().sort()) || group.some(d => d.kind === 'tags' ? JSON.stringify(d.base.tags) !== JSON.stringify(intent.base.tags) : d.base.notes !== intent.base.notes)) throw new EditingError('CORRUPT_DATA', '恢复草稿提交字段不匹配')
  }
  return doc
}
