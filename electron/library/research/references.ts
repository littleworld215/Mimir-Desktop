import type { ResearchPackVersion, ResearchResolvedItem } from '../../../shared/libraryResearchContracts'
import { currentEvidenceVersion } from '../evidence/service'
import type { ResearchContext, ResearchSnapshot } from './evidenceAccess'

/** 固定版本来自不可变历史；当前状态仅用于提示，不替换正文。 */
export function resolvePackItems(ctx: ResearchContext, snapshot: ResearchSnapshot, pack: ResearchPackVersion): ResearchResolvedItem[] {
  const questions = new Map(snapshot.document.questions.map(q => [q.id, q])), cards = new Map(snapshot.evidence?.cards.map(c => [c.id, c]))
  const projects = new Set(ctx.catalog.projects().map(p => p.id)), papers = new Set(ctx.catalog.papers().map(p => p.arxivId)), observations = ctx.sourceObservations()
  return pack.items.map(item => {
    const q = questions.get(item.questionId), card = cards.get(item.cardId)
    const question = q?.versions[item.questionVersion - 1], evidence = card?.versions[item.evidenceVersion - 1]
    const currentQ = q?.versions[q.currentVersion - 1], currentE = card && currentEvidenceVersion(card)
    const inspection = observations.get(`${item.cardId}:${item.evidenceVersion}`)
    return {
      item, ...(question ? { question } : {}), ...(evidence ? { evidence } : {}),
      status: {
        missingQuestion: !question, missingEvidence: !evidence, missingProject: !projects.has(pack.projectId),
        questionArchived: currentQ?.archived ?? false, evidenceArchived: currentE?.archived ?? false,
        projectDetached: Boolean((currentE && !currentE.projectIds.includes(pack.projectId)) || (evidence && !evidence.projectIds.includes(pack.projectId))),
        removedFromQuestion: Boolean(currentQ && !currentQ.evidenceCardIds.includes(item.cardId)),
        questionHasNewVersion: Boolean(q && q.currentVersion !== item.questionVersion), evidenceHasNewVersion: Boolean(card && card.currentVersion !== item.evidenceVersion)
      },
      sourceStatus: !evidence ? 'unknown' : !papers.has(evidence.paperId) ? 'detached' : inspection?.status ?? (evidence.documentBinding ? 'unchecked' : 'unbound'),
      ...(inspection?.checkedAt ? { checkedAt: inspection.checkedAt } : {})
    }
  })
}
export function researchItemNeedsAttention(item: ResearchResolvedItem): boolean {
  return Object.values(item.status).some(Boolean) || ['missing', 'changed', 'detached', 'unauthorized', 'unknown'].includes(item.sourceStatus)
}
