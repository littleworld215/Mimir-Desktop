import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createEvidence } from '../../../electron/library/evidence/service'
import { fields } from '../libraryEvidence/fixtures'
import type { SourceInspection } from '../../../shared/libraryEvidenceContracts'
import type { ResearchPackInput } from '../../../shared/libraryResearchContracts'
import { saveQuestion } from '../../../electron/library/research/questionService'

export const questionVersion = () => ({ version: 1, projectId: 'project-1', title: '研究问题', question: '小样本是否稳定？', note: '', evidenceCardIds: [randomUUID()], archived: false, updatedAt: '2026-10-18T00:00:00.000Z' })
export const question = () => ({ id: randomUUID(), createdAt: '2026-10-18T00:00:00.000Z', currentVersion: 1, versions: [questionVersion()] })
export const item = () => ({ id: randomUUID(), questionId: randomUUID(), questionVersion: 1, cardId: randomUUID(), evidenceVersion: 1, section: '背景', note: '' })
export const packVersion = () => ({ version: 1, projectId: 'project-1', title: '写作材料', note: '', items: [item()], archived: false, updatedAt: '2026-10-18T00:00:00.000Z' })
export const pack = () => ({ id: randomUUID(), createdAt: '2026-10-18T00:00:00.000Z', currentVersion: 1, versions: [packVersion()] })
export function document() {
  const q = question(), p = pack()
  p.versions[0]!.items[0] = { ...p.versions[0]!.items[0]!, questionId: q.id, cardId: q.versions[0]!.evidenceCardIds[0]! }
  return { schemaVersion: 1 as const, revision: 1, questions: [q], packs: [p] }
}
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-research-'))
  return { root, clean: () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mimir-research-')) throw Error('Unsafe research cleanup')
    rmSync(root, { recursive: true, force: true })
  } }
}
export function researchFixture(count = 1) {
  const f = fixture()
  const projects = [{ id: 'project-1', title: '课题一', createdAt: '2026-10-18', updatedAt: '2026-10-18' }]
  const papers = [{ arxivId: fields().paperId, title: '合成文献', authors: ['作者'], summary: '', url: 'https://example.org', notes: '旧笔记', tags: [], projectIds: ['project-1'], addedAt: '2026-10-18' }]
  const observations = new Map<string, SourceInspection>()
  const ctx = { scope: { id: 'space-1', epoch: 'epoch-1', root: f.root }, signal: new AbortController().signal, assertCurrent() {}, catalog: { papers: () => papers, projects: () => projects }, sourceObservations: () => new Map(observations) }
  const cards = [] as ReturnType<typeof createEvidence>['card'][]
  for (let i = 0; i < count; i++) cards.push(createEvidence(ctx, { ...fields(), quote: `${i} ${'字'.repeat(230)} ${i === count - 1 ? '尾部命中' : '普通'}` }, i).card)
  const input = { projectId: 'project-1', title: '问题', question: '是否稳定？', note: '', evidenceCardIds: cards.map(card => card.id) }
  return { ...f, ctx, cards, input, projects, papers, observations }
}
export function materialFixture(groupCount = 2) {
  const f = researchFixture(1)
  const questions = Array.from({ length: groupCount }, (_, i) => saveQuestion(f.ctx, { input: { ...f.input, title: `问题${i + 1}` }, expectedRevision: i, expectedEvidenceRevision: 1 }).question)
  const packInput: ResearchPackInput = { projectId: 'project-1', title: '合成素材', note: '', items: questions.map(q => ({ kind: 'new', questionId: q.id, cardId: f.cards[0]!.id, section: '讨论', note: '个人说明' })) }
  return { ...f, questions, packInput, researchRevision: groupCount }
}
