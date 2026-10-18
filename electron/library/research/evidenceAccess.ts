import { existsSync } from 'node:fs'
import type { EvidenceDocument, SourceInspection } from '../../../shared/libraryEvidenceContracts'
import type { ResearchDocument, ResearchReadState } from '../../../shared/libraryResearchContracts'
import type { EvidenceContext } from '../evidence/service'
import { evidencePath, readEvidence } from '../evidence/repository'
import { EvidenceError } from '../evidence/validation'
import { readResearch } from './repository'
import { assertResearchRevision, ResearchError } from './validation'

/** 观察端口按调用时读取，不能把旧Map跨原生选择窗口缓存。 */
export type ResearchContext = EvidenceContext & { sourceObservations(): ReadonlyMap<string, SourceInspection> }
export interface ResearchSnapshot { document: ResearchDocument; evidence?: EvidenceDocument; state: ResearchReadState }
export function assertResearchContext(ctx: ResearchContext): void {
  if (ctx.signal.aborted) throw new ResearchError('CANCELED', '研究操作已取消，输入保留')
  try { ctx.assertCurrent() }
  catch (error) {
    if (error instanceof EvidenceError) throw new ResearchError(error.code, error.message, error.currentRevision)
    throw error
  }
}
export function readResearchSnapshot(ctx: ResearchContext): ResearchSnapshot {
  assertResearchContext(ctx)
  const document = readResearch(ctx.scope.root)
  try {
    const present = existsSync(evidencePath(ctx.scope.root)), evidence = readEvidence(ctx.scope.root)
    return { document, evidence, state: { revision: document.revision, evidenceRevision: evidence.revision, evidenceState: present ? 'available' : 'absent' } }
  } catch (error) {
    return { document, state: { revision: document.revision, evidenceRevision: null, evidenceState: error instanceof EvidenceError && error.code === 'FORMAT_UNSUPPORTED' ? 'unsupported' : 'unreadable' } }
  }
}
export function assertResearchExpected(snapshot: ResearchSnapshot, expectedRevision: number, expectedEvidenceRevision?: number): void {
  assertResearchRevision(expectedRevision)
  if (snapshot.document.revision !== expectedRevision) throw new ResearchError('CONFLICT', '研究资料已有更新，请保留输入并重新加载', snapshot.document.revision)
  if (expectedEvidenceRevision !== undefined) {
    assertResearchRevision(expectedEvidenceRevision)
    if (!snapshot.evidence) throw new ResearchError('REFERENCE_UNRESOLVED', '证据文件暂不可读，不能新增或更新引用')
    if (snapshot.evidence.revision !== expectedEvidenceRevision) throw new ResearchError('CONFLICT', '证据已有更新，请重新选择', snapshot.document.revision, snapshot.evidence.revision)
  }
}
