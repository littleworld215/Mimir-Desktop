import { randomUUID } from 'node:crypto'
import type { ResearchQuestionInput, ResearchQuestionReply, ResearchQuestionVersion } from '../../../shared/libraryResearchContracts'
import { currentEvidenceVersion } from '../evidence/service'
import { assertResearchContext, assertResearchExpected, readResearchSnapshot, type ResearchContext, type ResearchSnapshot } from './evidenceAccess'
import { commitResearch } from './repository'
import { questionInputSchema, ResearchError } from './validation'

export function findQuestion(snapshot: ResearchSnapshot, id: string) {
  const question = snapshot.document.questions.find(q => q.id === id)
  if (!question) throw new ResearchError('NOT_FOUND', '研究问题不存在')
  return question
}
function assertNewLinks(ctx: ResearchContext, snapshot: ResearchSnapshot, input: ResearchQuestionInput, added: string[], expectedEvidenceRevision?: number): void {
  if (!added.length) return
  if (expectedEvidenceRevision === undefined) throw new ResearchError('BAD_REQUEST', '选择证据需要当前证据修订号')
  assertResearchExpected(snapshot, snapshot.document.revision, expectedEvidenceRevision)
  if (!ctx.catalog.projects().some(p => p.id === input.projectId)) throw new ResearchError('NOT_FOUND', '项目已移除，不能新增引用')
  for (const id of added) {
    const card = snapshot.evidence!.cards.find(c => c.id === id), v = card && currentEvidenceVersion(card)
    if (!v || v.archived || !v.projectIds.includes(input.projectId)) throw new ResearchError('REFERENCE_UNRESOLVED', '所选证据缺失、已归档或不属于该项目')
  }
}
export function saveQuestion(ctx: ResearchContext, request: { questionId?: string; input: ResearchQuestionInput; expectedRevision: number; expectedEvidenceRevision?: number }): ResearchQuestionReply {
  const parsed = questionInputSchema.safeParse(request.input)
  if (!parsed.success) throw new ResearchError('BAD_REQUEST', '问题字段非法或超限')
  const input = parsed.data, snapshot = readResearchSnapshot(ctx)
  assertResearchExpected(snapshot, request.expectedRevision)
  const old = request.questionId ? findQuestion(snapshot, request.questionId) : undefined, previous = old?.versions[old.currentVersion - 1]
  if (previous && previous.projectId !== input.projectId) throw new ResearchError('BAD_REQUEST', '问题所属项目创建后不可更换')
  if (!previous && !ctx.catalog.projects().some(p => p.id === input.projectId)) throw new ResearchError('NOT_FOUND', '请先选择已有项目')
  const added = input.evidenceCardIds.filter(id => !previous?.evidenceCardIds.includes(id))
  if (previous?.archived && added.length) throw new ResearchError('BAD_REQUEST', '请先恢复问题组再新增引用')
  assertNewLinks(ctx, snapshot, input, added, request.expectedEvidenceRevision)
  if (previous && JSON.stringify({ projectId: previous.projectId, title: previous.title, question: previous.question, note: previous.note, evidenceCardIds: previous.evidenceCardIds }) === JSON.stringify(input)) return { ...snapshot.state, question: old! }
  const now = new Date().toISOString(), v: ResearchQuestionVersion = { ...input, version: (previous?.version ?? 0) + 1, archived: previous?.archived ?? false, updatedAt: now }
  const question = old ? { ...old, currentVersion: v.version, versions: [...old.versions, v] } : { id: randomUUID(), createdAt: now, currentVersion: 1, versions: [v] }
  const next = commitResearch(ctx.scope.root, request.expectedRevision, { ...snapshot.document, revision: snapshot.document.revision + 1, questions: old ? snapshot.document.questions.map(q => q.id === old.id ? question : q) : [...snapshot.document.questions, question] }, () => {
    const latest = readResearchSnapshot(ctx)
    assertResearchExpected(latest, request.expectedRevision)
    if (!previous && !ctx.catalog.projects().some(p => p.id === input.projectId)) throw new ResearchError('NOT_FOUND', '保存期间项目已移除')
    assertNewLinks(ctx, latest, input, added, request.expectedEvidenceRevision)
  })
  return { ...snapshot.state, revision: next.revision, question }
}
export function archiveQuestion(ctx: ResearchContext, id: string, archived: boolean, expectedRevision: number): ResearchQuestionReply {
  if (typeof archived !== 'boolean') throw new ResearchError('BAD_REQUEST', '归档值非法')
  const snapshot = readResearchSnapshot(ctx)
  assertResearchExpected(snapshot, expectedRevision)
  const old = findQuestion(snapshot, id), previous = old.versions[old.currentVersion - 1]!
  if (previous.archived === archived) return { ...snapshot.state, question: old }
  const v = { ...previous, version: previous.version + 1, archived, updatedAt: new Date().toISOString() }
  const question = { ...old, currentVersion: v.version, versions: [...old.versions, v] }
  const next = commitResearch(ctx.scope.root, expectedRevision, { ...snapshot.document, revision: expectedRevision + 1, questions: snapshot.document.questions.map(q => q.id === id ? question : q) }, () => assertResearchContext(ctx))
  return { ...snapshot.state, revision: next.revision, question }
}
