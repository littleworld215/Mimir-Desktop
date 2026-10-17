import { z } from 'zod'
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_CARDS, type EvidenceDocument, type EvidenceErrorCode, type EvidenceFields } from '../../../shared/libraryEvidenceContracts'

export class EvidenceError extends Error {
  constructor(readonly code: EvidenceErrorCode, message: string = code, readonly currentRevision?: number) {
    super(`${code}: ${message}`)
    this.name = 'EvidenceError'
  }
}
const text = (limit: number) => z.string().refine(value => Array.from(value).length <= limit, '内容超长')
const id = z.string().min(1).max(1000)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const date = z.string().datetime()
const fieldsShape = {
  paperId: id,
  projectIds: z.array(id).max(5000).refine(ids => new Set(ids).size === ids.length),
  question: text(2000), claim: text(2000), quote: text(20000), comment: text(20000),
  method: text(4000), datasetOrMaterial: text(4000), finding: text(4000), limitation: text(4000),
  relation: z.enum(['supports', 'opposes', 'mixed', 'unassessed']),
  locator: z.object({ pageStart: integer.positive().optional(), pageEnd: integer.positive().optional(), printedPageLabel: text(500).optional(), section: text(500).optional(), figureOrTable: text(500).optional() }).strict()
    .refine(v => v.pageEnd === undefined || (v.pageStart !== undefined && v.pageEnd >= v.pageStart))
}
const meaningful = (v: { quote: string; claim: string }) => v.quote.trim() !== '' || v.claim.trim() !== ''
const fieldsSchema = z.object(fieldsShape).strict().refine(meaningful, '摘录和判断不能同时为空')
const versionSchema = z.object({
  ...fieldsShape, version: integer.positive(),
  paperSnapshot: z.object({ id, title: z.string(), authors: z.array(z.string()), url: z.string() }).strict(),
  documentBinding: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: integer, checkedAt: date }).strict().nullable(),
  reviewState: z.enum(['draft', 'checked']), archived: z.boolean(), updatedAt: date
}).strict().refine(meaningful).refine(v => v.paperSnapshot.id === v.paperId)
  .refine(v => v.reviewState !== 'checked' || v.documentBinding !== null)
const cardSchema = z.object({ id: z.string().uuid(), createdAt: date, currentVersion: integer.positive(), versions: z.array(versionSchema).min(1) }).strict()
  .refine(card => card.currentVersion === card.versions.length && card.versions.every((v, i) => v.version === i + 1))
const documentSchema = z.object({ schemaVersion: z.literal(1), revision: integer, cards: z.array(cardSchema).max(EVIDENCE_MAX_CARDS) }).strict()
  .refine(doc => new Set(doc.cards.map(c => c.id)).size === doc.cards.length)

export function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw new EvidenceError('BAD_REQUEST', '版本号非法')
}
export function parseEvidenceFields(input: unknown): EvidenceFields {
  const result = fieldsSchema.safeParse(input)
  if (!result.success) throw new EvidenceError('BAD_REQUEST', '证据字段非法或超限')
  return result.data
}
export function parseEvidenceDocument(input: unknown): EvidenceDocument {
  if (input && typeof input === 'object' && 'schemaVersion' in input && typeof input.schemaVersion === 'number' && input.schemaVersion > 1) throw new EvidenceError('FORMAT_UNSUPPORTED', '证据格式较新，当前版本只读保留')
  if (input && typeof input === 'object' && 'cards' in input && Array.isArray(input.cards) && input.cards.length > EVIDENCE_MAX_CARDS) throw new EvidenceError('LIMIT_EXCEEDED', '证据卡超过5000条')
  const result = documentSchema.safeParse(input)
  if (!result.success) throw new EvidenceError('CORRUPT_DATA', '证据文件结构不完整，已拒绝写入')
  return result.data
}
export function assertEvidenceBytes(bytes: { readonly byteLength: number }): void {
  if (bytes.byteLength > EVIDENCE_MAX_BYTES) throw new EvidenceError('LIMIT_EXCEEDED', '证据全部历史超过32MiB，原数据已保留')
}
