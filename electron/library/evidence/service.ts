import { randomUUID } from 'node:crypto'
import type { EvidenceCard, EvidenceDocument, EvidenceFields, EvidenceVersion } from '../../../shared/libraryEvidenceContracts'
import type { PaperRecord, ProjectRecord } from '../types'
import type { OperationScope } from '../../workspaceBackup/operationGate'
import { commitEvidence, readEvidence } from './repository'
import { assertRevision, EvidenceError, parseEvidenceFields } from './validation'

export interface EvidenceContext {
  scope: OperationScope
  signal: AbortSignal
  assertCurrent(): void
  catalog: { papers(): readonly PaperRecord[]; projects(): readonly ProjectRecord[] }
}
export function assertEvidenceContext(ctx: EvidenceContext): void {
  if (ctx.signal.aborted) throw new EvidenceError('CANCELED', '操作已取消，输入保留')
  ctx.assertCurrent()
}
export const currentEvidenceVersion = (card: EvidenceCard): EvidenceVersion => card.versions[card.currentVersion - 1]!
export function evidenceDetail(ctx: EvidenceContext, cardId: string): { document: EvidenceDocument; card: EvidenceCard } {
  assertEvidenceContext(ctx)
  const document = readEvidence(ctx.scope.root), card = document.cards.find(c => c.id === cardId)
  if (!card) throw new EvidenceError('NOT_FOUND', '证据卡不存在')
  return { document, card }
}
function checkRevision(document: EvidenceDocument, expectedRevision: number): void {
  assertRevision(expectedRevision)
  if (document.revision !== expectedRevision) throw new EvidenceError('CONFLICT', '证据已变化，请保留输入并重新加载', document.revision)
}
function assertReferences(ctx: EvidenceContext, input: EvidenceFields, previous?: EvidenceVersion) {
  const changedPaper = !previous || input.paperId !== previous.paperId
  const paper = ctx.catalog.papers().find(p => p.arxivId === input.paperId)
  if (changedPaper && !paper) throw new EvidenceError('NOT_FOUND', '来源文献不存在')
  for (const id of input.projectIds) {
    if (!previous?.projectIds.includes(id) && !ctx.catalog.projects().some(p => p.id === id)) throw new EvidenceError('NOT_FOUND', '关联项目不存在')
  }
  if (!changedPaper) return previous.paperSnapshot
  return { id: paper!.arxivId, title: paper!.title, authors: [...paper!.authors], url: paper!.url }
}
export function createEvidence(ctx: EvidenceContext, value: unknown, expectedRevision: number) {
  assertEvidenceContext(ctx)
  const document = readEvidence(ctx.scope.root)
  checkRevision(document, expectedRevision)
  const input = parseEvidenceFields(value), paperSnapshot = assertReferences(ctx, input), now = new Date().toISOString()
  const card: EvidenceCard = { id: randomUUID(), createdAt: now, currentVersion: 1, versions: [{ ...input, version: 1, paperSnapshot, documentBinding: null, reviewState: 'draft', archived: false, updatedAt: now }] }
  const next = commitEvidence(ctx.scope.root, expectedRevision, { ...document, revision: document.revision + 1, cards: [...document.cards, card] }, () => assertEvidenceContext(ctx))
  return { document: next, card: next.cards.find(c => c.id === card.id)! }
}
/** 仅供主进程可信来源确认等业务使用；transform不进入IPC合同。 */
export function reviseEvidence(ctx: EvidenceContext, cardId: string, expectedRevision: number, transform: (previous: EvidenceVersion) => EvidenceVersion) {
  const { document, card } = evidenceDetail(ctx, cardId)
  checkRevision(document, expectedRevision)
  const previous = currentEvidenceVersion(card), proposed = transform(structuredClone(previous))
  if (JSON.stringify(proposed) === JSON.stringify(previous)) return { document, card }
  const nextVersion = { ...proposed, version: previous.version + 1, updatedAt: new Date().toISOString() }
  const nextCard = { ...card, currentVersion: nextVersion.version, versions: [...card.versions, nextVersion] }
  const next = commitEvidence(ctx.scope.root, expectedRevision, { ...document, revision: document.revision + 1, cards: document.cards.map(c => c.id === cardId ? nextCard : c) }, () => assertEvidenceContext(ctx))
  return { document: next, card: next.cards.find(c => c.id === cardId)! }
}
export function updateEvidence(ctx: EvidenceContext, cardId: string, value: unknown, expectedRevision: number) {
  return reviseEvidence(ctx, cardId, expectedRevision, previous => {
    const input = parseEvidenceFields(value), paperSnapshot = assertReferences(ctx, input, previous)
    const oldFields = parseEvidenceFields(Object.fromEntries(Object.keys(input).map(key => [key, previous[key as keyof EvidenceFields]])))
    if (JSON.stringify(oldFields) === JSON.stringify(input)) return previous
    return { ...previous, ...input, paperSnapshot, reviewState: 'draft', documentBinding: input.paperId === previous.paperId ? previous.documentBinding : null }
  })
}
export function archiveEvidence(ctx: EvidenceContext, cardId: string, archived: boolean, expectedRevision: number) {
  if (typeof archived !== 'boolean') throw new EvidenceError('BAD_REQUEST', '归档参数非法')
  return reviseEvidence(ctx, cardId, expectedRevision, previous => ({ ...previous, archived }))
}
