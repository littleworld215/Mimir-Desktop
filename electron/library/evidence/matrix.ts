import type { EvidenceCard, EvidenceDocument, EvidenceFilter, EvidenceMatrixRow, EvidenceVersion, SourceInspection } from '../../../shared/libraryEvidenceContracts'
import type { PaperRecord } from '../types'
import { EvidenceError } from './validation'
import { currentEvidenceVersion } from './service'

export interface EvidenceViewContext { papers?: readonly PaperRecord[]; observations?: ReadonlyMap<string, SourceInspection> }
export function evidenceSourceStatus(card: EvidenceCard, context: EvidenceViewContext): SourceInspection {
  const v = currentEvidenceVersion(card)
  if (context.papers && !context.papers.some(p => p.arxivId === v.paperId)) return { status: 'detached' }
  return context.observations?.get(`${card.id}:${v.version}`) ?? { status: v.documentBinding ? 'unchecked' : 'unbound' }
}
function searchable(v: EvidenceVersion): string {
  return [v.paperId, v.paperSnapshot.title, ...v.paperSnapshot.authors, v.question, v.claim, v.quote, v.method, v.datasetOrMaterial, v.finding, v.limitation, v.comment, v.locator.printedPageLabel, v.locator.section, v.locator.figureOrTable].join('\n').toLocaleLowerCase()
}
export function selectEvidenceCards(doc: EvidenceDocument, filter: EvidenceFilter, context: EvidenceViewContext = {}): EvidenceCard[] {
  const keyword = (filter.keyword ?? '').trim().toLocaleLowerCase()
  return doc.cards.filter(card => {
    const v = currentEvidenceVersion(card)
    if ((filter.archive === 'exclude' && v.archived) || (filter.archive === 'only' && !v.archived) || (filter.projectId && !v.projectIds.includes(filter.projectId)) || (filter.reviewState && v.reviewState !== filter.reviewState)) return false
    if (keyword && !searchable(v).includes(keyword)) return false
    return filter.source !== 'problem' || ['missing', 'changed', 'detached', 'unauthorized'].includes(evidenceSourceStatus(card, context).status)
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
export function deriveEvidenceMatrix(doc: EvidenceDocument, papers: readonly PaperRecord[], projects: readonly { id: string }[], filter: EvidenceFilter, page: number, observations: ReadonlyMap<string, SourceInspection>) {
  if (!Number.isSafeInteger(page) || page < 1) throw new EvidenceError('BAD_REQUEST', '页码非法')
  const grouped = new Map<string, EvidenceMatrixRow>(), validProjects = new Set(projects.map(p => p.id))
  // 默认范围保留尚未整理证据的现有文献；显式证据筛选不伪造空白命中。
  if (!filter.reviewState && filter.source === 'all' && filter.archive === 'exclude') {
    const keyword = (filter.keyword ?? '').trim().toLocaleLowerCase()
    for (const paper of papers) {
      if ((filter.projectId && !paper.projectIds.includes(filter.projectId)) || (keyword && ![paper.arxivId, paper.title, ...paper.authors].join('\n').toLocaleLowerCase().includes(keyword))) continue
      grouped.set(paper.arxivId, { paperId: paper.arxivId, paperSnapshot: { id: paper.arxivId, title: paper.title, authors: [...paper.authors], url: paper.url }, missingPaper: false, missingProjectIds: [], cards: [] })
    }
  }
  for (const card of selectEvidenceCards(doc, filter, { papers, observations })) {
    const v = currentEvidenceVersion(card), paper = papers.find(p => p.arxivId === v.paperId)
    const row = grouped.get(v.paperId) ?? { paperId: v.paperId, paperSnapshot: paper ? { id: paper.arxivId, title: paper.title, authors: [...paper.authors], url: paper.url } : { ...v.paperSnapshot, authors: [...v.paperSnapshot.authors] }, missingPaper: !paper, missingProjectIds: [], cards: [] }
    row.missingProjectIds = [...new Set([...row.missingProjectIds, ...v.projectIds.filter(id => !validProjects.has(id))])].sort()
    const preview = (text: string) => Array.from(text).slice(0, 200).join(''), inspection = evidenceSourceStatus(card, { papers, observations })
    row.cards.push({ cardId: card.id, version: v.version, question: preview(v.question), method: preview(v.method), datasetOrMaterial: preview(v.datasetOrMaterial), finding: preview(v.finding), limitation: preview(v.limitation), locator: { ...v.locator }, relation: v.relation, reviewState: v.reviewState, archived: v.archived, sourceStatus: inspection.status, ...(inspection.checkedAt ? { checkedAt: inspection.checkedAt } : {}) })
    grouped.set(v.paperId, row)
  }
  const all = [...grouped.values()].sort((a, b) => a.paperId < b.paperId ? -1 : a.paperId > b.paperId ? 1 : 0)
  return { rows: all.slice((page - 1) * 50, page * 50), total: all.length, page, pageSize: 50 as const }
}
