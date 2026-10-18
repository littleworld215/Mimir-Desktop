import type { EvidenceCard, EvidenceRelation, EvidenceVersion } from '../../../shared/libraryEvidenceContracts'
import type { ResearchEvidenceRow, ResearchFilter, ResearchPage, ResearchQuestionDetail, ResearchQuestionSummary } from '../../../shared/libraryResearchContracts'
import { currentEvidenceVersion } from '../evidence/service'
import { readResearchSnapshot, type ResearchContext, type ResearchSnapshot } from './evidenceAccess'
import { findQuestion } from './questionService'
import { ResearchError } from './validation'

export function assertResearchPage(page: number): void {
  if (!Number.isSafeInteger(page) || page < 1) throw new ResearchError('BAD_REQUEST', '页码非法')
}
export const researchPreview = (s: string) => Array.from(s).slice(0, 200).join('')
export function evidenceMatches(v: EvidenceVersion, keyword = ''): boolean {
  return [v.paperId, v.paperSnapshot.title, ...v.paperSnapshot.authors, v.question, v.claim, v.quote, v.method, v.datasetOrMaterial, v.finding, v.limitation, v.comment, ...Object.values(v.locator)].join('\n').toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase())
}
function createRowReader(ctx: ResearchContext, snapshot: ResearchSnapshot) {
  const cards = new Map(snapshot.evidence?.cards.map(c => [c.id, c])), projects = new Set(ctx.catalog.projects().map(p => p.id)), papers = new Set(ctx.catalog.papers().map(p => p.arxivId)), observations = ctx.sourceObservations()
  return (cardId: string, projectId: string): ResearchEvidenceRow => {
    const card = cards.get(cardId), v = card && currentEvidenceVersion(card)
    const missingProject = !projects.has(projectId)
    const problems = [...(missingProject ? ['项目已移除'] : []), ...(!v ? ['证据缺失或不可读'] : []), ...(v?.archived ? ['证据已归档'] : []), ...(v && !v.projectIds.includes(projectId) ? ['证据已移出项目'] : [])]
    const inspection = v && observations.get(`${cardId}:${v.version}`)
    const sourceStatus = !v ? 'unknown' : !papers.has(v.paperId) ? 'detached' : inspection?.status ?? (v.documentBinding ? 'unchecked' : 'unbound')
    if (sourceStatus === 'detached') problems.push('来源文献已移除')
    else if (['missing', 'changed', 'unauthorized'].includes(sourceStatus)) problems.push('来源异常')
    return {
      cardId, version: v?.version ?? null, ...(v ? { paperId: v.paperId, paperTitle: v.paperSnapshot.title } : {}),
      question: researchPreview(v?.question ?? ''), claim: researchPreview(v?.claim ?? ''), quote: researchPreview(v?.quote ?? ''), method: researchPreview(v?.method ?? ''), datasetOrMaterial: researchPreview(v?.datasetOrMaterial ?? ''), finding: researchPreview(v?.finding ?? ''), limitation: researchPreview(v?.limitation ?? ''),
      relation: v?.relation ?? 'unknown', reviewState: v?.reviewState ?? 'unknown', locator: v?.locator ?? {},
      sourceStatus,
      ...(inspection?.checkedAt ? { checkedAt: inspection.checkedAt } : {}), problems
    }
  }
}
export function listQuestions(ctx: ResearchContext, filter: ResearchFilter, page: number): ResearchPage<ResearchQuestionSummary> {
  assertResearchPage(page)
  const snapshot = readResearchSnapshot(ctx), keyword = (filter.keyword ?? '').trim().toLocaleLowerCase(), row = createRowReader(ctx, snapshot)
  const all = snapshot.document.questions.filter(q => {
    const v = q.versions[q.currentVersion - 1]!
    return (!filter.projectId || filter.projectId === v.projectId) && (filter.archive === 'include' || v.archived === (filter.archive === 'only')) && [v.title, v.question, v.note].join('\n').toLocaleLowerCase().includes(keyword)
  }).map(q => {
    const v = q.versions[q.currentVersion - 1]!, missingProject = !ctx.catalog.projects().some(p => p.id === v.projectId)
    return { id: q.id, projectId: v.projectId, title: v.title, currentVersion: q.currentVersion, archived: v.archived, cardCount: v.evidenceCardIds.length, problemCount: snapshot.evidence ? v.evidenceCardIds.filter(id => row(id, v.projectId).problems.length > 0).length + (missingProject ? 1 : 0) : null }
  })
  return { ...snapshot.state, items: all.slice((page - 1) * 50, page * 50), total: all.length, page, pageSize: 50 }
}
export function questionDetail(ctx: ResearchContext, request: { questionId: string; version?: number; page: number; keyword?: string; relation?: EvidenceRelation }): ResearchQuestionDetail {
  assertResearchPage(request.page)
  const snapshot = readResearchSnapshot(ctx), question = findQuestion(snapshot, request.questionId), selectedVersion = request.version ?? question.currentVersion, row = createRowReader(ctx, snapshot)
  if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1 || selectedVersion > question.currentVersion) throw new ResearchError('NOT_FOUND', '问题历史版本不存在')
  const v = question.versions[selectedVersion - 1]!, relationCounts = { supports: 0, opposes: 0, mixed: 0, unassessed: 0, unknown: 0 }
  const cards = new Map(snapshot.evidence?.cards.map(c => [c.id, c]))
  const all = v.evidenceCardIds.filter(id => {
    const card = cards.get(id), current = card && currentEvidenceVersion(card)
    return (!request.keyword?.trim() || (current ? evidenceMatches(current, request.keyword) : id.toLocaleLowerCase().includes(request.keyword.trim().toLocaleLowerCase()))) && (!request.relation || current?.relation === request.relation)
  }).map(id => row(id, v.projectId))
  all.forEach(r => { relationCounts[r.relation]++ })
  return { ...snapshot.state, question, selectedVersion, rows: all.slice((request.page - 1) * 50, request.page * 50), total: all.length, page: request.page, pageSize: 50, relationCounts }
}
export function listEvidence(ctx: ResearchContext, request: { projectId: string; keyword?: string; relation?: EvidenceRelation; page: number }): ResearchPage<ResearchEvidenceRow> {
  assertResearchPage(request.page)
  const snapshot = readResearchSnapshot(ctx)
  if (!snapshot.evidence) throw new ResearchError('REFERENCE_UNRESOLVED', '证据不可读，暂不能选择')
  if (!ctx.catalog.projects().some(p => p.id === request.projectId)) throw new ResearchError('NOT_FOUND', '项目已移除')
  const row = createRowReader(ctx, snapshot)
  const all: EvidenceCard[] = snapshot.evidence.cards.filter(card => {
    const v = currentEvidenceVersion(card)
    return !v.archived && v.projectIds.includes(request.projectId) && evidenceMatches(v, request.keyword) && (!request.relation || v.relation === request.relation)
  })
  return { ...snapshot.state, items: all.slice((request.page - 1) * 50, request.page * 50).map(c => row(c.id, request.projectId)), total: all.length, page: request.page, pageSize: 50 }
}
