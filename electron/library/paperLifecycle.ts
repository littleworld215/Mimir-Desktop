import { createHash, randomUUID } from 'node:crypto'
import type { PaperLifecycleScope, PaperLifecyclePreview } from '../../shared/libraryLifecycle'
import { isPaperTrashed } from '../../shared/libraryLifecycle'
import { captureWorkspaceOperation, getStoreValue } from './store'
import { listTrashedPapers, removePaper, restorePaper } from './libraryService'
import type { PaperRecord, ProjectRecord } from './types'
import { readEvidence } from './evidence/repository'
import { readResearch } from './research/repository'
import { createPlanningRepository, createPlanningDraftRepository } from '../researchPlanning/repository'
import { assertPaperMetadata } from './integrity'

function scopeOf(current: ReturnType<typeof captureWorkspaceOperation>): PaperLifecycleScope {
  return { workspaceId: current.id, spaceEpoch: current.epoch }
}
function snapshot(arxivId: string) {
  const current = captureWorkspaceOperation()
  const papers = getStoreValue<Record<string, PaperRecord>>('library:papers') ?? {}
  const paper = papers[arxivId]
  if (!paper) throw Error('文献不存在，请刷新')
  assertPaperMetadata(paper as unknown as Record<string, unknown>)
  const projects = getStoreValue<ProjectRecord[]>('library:projects') ?? []
  // Existing repositories validate paths, sizes and complete histories. Failure blocks the preview.
  const evidence = readEvidence(current.root), research = readResearch(current.root)
  const planning = createPlanningRepository().read(current.root), drafts = createPlanningDraftRepository().read(current.root)
  const cardIds = new Set(evidence.cards.filter(c => c.versions.some(v => v.paperId === arxivId)).map(c => c.id))
  const counts = {
    evidenceCards: cardIds.size,
    evidenceVersions: evidence.cards.reduce((sum, c) => sum + c.versions.filter(v => v.paperId === arxivId).length, 0),
    questions: research.questions.filter(q => q.versions.some(v => v.evidenceCardIds.some(id => cardIds.has(id)))).length,
    packs: research.packs.filter(p => p.versions.some(v => v.items.some(i => cardIds.has(i.cardId)))).length,
    planningItems: planning.items.filter(i => i.literature?.paperId === arxivId).length,
    planningDrafts: drafts.drafts.filter(d => d.input.literature?.paperId === arxivId).length
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ current, papers, projects, evidence, research, planning, drafts })).digest('hex')
  return { current, paper, projects, counts, fingerprint }
}
/** One main-window controller; opaque previews are scoped, bounded, short-lived and single-use. */
export function createPaperLifecycleController() {
  const pending = new Map<string, { scope: PaperLifecycleScope; arxivId: string; action: 'trash' | 'restore'; fingerprint: string; expires: number }>()
  function assertScope(scope: PaperLifecycleScope) {
    const current = scopeOf(captureWorkspaceOperation())
    if (scope.workspaceId !== current.workspaceId || scope.spaceEpoch !== current.spaceEpoch) throw Error('科研空间已变化，请重新打开文献库')
  }
  return {
    overview() {
      return { scope: scopeOf(captureWorkspaceOperation()), papers: listTrashedPapers().map(p => ({
        arxivId: p.arxivId, title: p.title, removedAt: String(p.removedAt), hasPdf: !!p.pdfPath, tagCount: p.tags.length
      })) }
    },
    preview(scope: PaperLifecycleScope, arxivId: string, action: 'trash' | 'restore'): PaperLifecyclePreview {
      assertScope(scope)
      const data = snapshot(arxivId)
      if (isPaperTrashed(data.paper) !== (action === 'restore')) throw Error('文献状态已变化，请刷新')
      const token = randomUUID(), known = new Map(data.projects.map(p => [p.id, p.title]))
      if (pending.size >= 20) pending.delete(pending.keys().next().value!)
      pending.set(token, { scope: { ...scope }, arxivId, action, fingerprint: data.fingerprint, expires: Date.now() + 5 * 60_000 })
      return { arxivId, title: data.paper.title, action, token, counts: data.counts,
        projectNames: data.paper.projectIds.filter(id => known.has(id)).map(id => known.get(id)!),
        missingProjectIds: data.paper.projectIds.filter(id => !known.has(id)) }
    },
    async apply(scope: PaperLifecycleScope, token: string): Promise<void> {
      assertScope(scope)
      const preview = pending.get(token)
      if (!preview || preview.expires < Date.now() || preview.scope.workspaceId !== scope.workspaceId || preview.scope.spaceEpoch !== scope.spaceEpoch) throw Error('影响预览已失效，请重新预览')
      const data = snapshot(preview.arxivId)
      if (data.fingerprint !== preview.fingerprint) throw Error('文献或关联已变化，请重新预览')
      assertScope(scope)
      if (preview.action === 'trash') await removePaper(preview.arxivId)
      else restorePaper(preview.arxivId)
      pending.delete(token)
    }
  }
}
