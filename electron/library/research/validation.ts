import { z } from 'zod'
import { RESEARCH_MAX_BYTES, RESEARCH_MAX_ITEMS, RESEARCH_MAX_PACKS, RESEARCH_MAX_QUESTIONS, type ResearchDocument, type ResearchErrorCode } from '../../../shared/libraryResearchContracts'

export class ResearchError extends Error {
  constructor(readonly code: ResearchErrorCode, message: string = code, readonly currentRevision?: number, readonly currentEvidenceRevision?: number) {
    super(`${code}: ${message}`)
    this.name = 'ResearchError'
  }
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const version = integer.positive(), uuid = z.string().uuid(), id = z.string().min(1).max(1000)
const text = (limit: number) => z.string().refine(s => Array.from(s).length <= limit, '内容超长')
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length
export const questionInputSchema = z.object({ projectId: id, title: text(200), question: text(2000), note: text(2000), evidenceCardIds: z.array(uuid).max(RESEARCH_MAX_ITEMS).refine(unique) }).strict()
const questionVersionSchema = questionInputSchema.extend({ version, archived: z.boolean(), updatedAt: z.string().datetime() }).strict()
const itemSchema = z.object({ id: uuid, questionId: uuid, questionVersion: version, cardId: uuid, evidenceVersion: version, section: text(200), note: text(2000) }).strict()
const packVersionSchema = z.object({ version, projectId: id, title: text(200), note: text(2000), archived: z.boolean(), updatedAt: z.string().datetime(), items: z.array(itemSchema).max(RESEARCH_MAX_ITEMS) }).strict()
  .refine(v => unique(v.items.map(i => i.id)) && unique(v.items.map(i => `${i.questionId}:${i.cardId}`)))
export const packInputSchema = z.object({ projectId: id, title: text(200), note: text(2000), items: z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), itemId: uuid, section: text(200), note: text(2000) }).strict(),
  z.object({ kind: z.literal('new'), questionId: uuid, cardId: uuid, section: text(200), note: text(2000) }).strict()
])).max(RESEARCH_MAX_ITEMS) }).strict()
const entityShape = { id: uuid, createdAt: z.string().datetime(), currentVersion: version }
const validVersions = (entity: { currentVersion: number; versions: { version: number; projectId: string }[] }) => entity.currentVersion === entity.versions.length && entity.versions.every((v, i) => v.version === i + 1 && v.projectId === entity.versions[0]?.projectId)
const questionSchema = z.object({ ...entityShape, versions: z.array(questionVersionSchema).min(1) }).strict().refine(validVersions)
const packSchema = z.object({ ...entityShape, versions: z.array(packVersionSchema).min(1) }).strict().refine(validVersions)
const documentSchema = z.object({ schemaVersion: z.literal(1), revision: integer, questions: z.array(questionSchema).max(RESEARCH_MAX_QUESTIONS), packs: z.array(packSchema).max(RESEARCH_MAX_PACKS) }).strict()
  .refine(doc => unique([...doc.questions.map(q => q.id), ...doc.packs.map(p => p.id)]))

export function assertResearchRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ResearchError('BAD_REQUEST', '修订号非法')
}
export function assertResearchBytes(bytes: { readonly byteLength: number }): void {
  if (bytes.byteLength > RESEARCH_MAX_BYTES) throw new ResearchError('LIMIT_EXCEEDED', '研究组织全部历史超过16MiB，原数据已保留')
}
/** 业务断链由派生报告表达；结构解析不丢弃历史或猜测修复。 */
export function parseResearchDocument(input: unknown): ResearchDocument {
  if (input && typeof input === 'object' && 'schemaVersion' in input && typeof input.schemaVersion === 'number' && input.schemaVersion > 1) throw new ResearchError('FORMAT_UNSUPPORTED', '研究组织格式较新，原文件保留')
  const result = documentSchema.safeParse(input)
  if (!result.success) {
    if (result.error.issues.some(issue => issue.code === 'too_big' && issue.type === 'array')) throw new ResearchError('LIMIT_EXCEEDED', '研究问题、素材包或历史引用数量超过限额')
    throw new ResearchError('CORRUPT_DATA', '研究组织结构不完整，已拒绝写入')
  }
  return result.data
}
