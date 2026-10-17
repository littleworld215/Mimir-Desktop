/** 证据域纯DTO；可信快照/绑定永远不来自人工编辑请求。 */
export const EVIDENCE_MAX_CARDS = 5000
export const EVIDENCE_MAX_BYTES = 32 * 1024 * 1024
export const EVIDENCE_PAGE_SIZE = 50
export const EVIDENCE_CHANNELS = Object.fromEntries(
  ['list', 'detail', 'create', 'update', 'archive', 'checkSource', 'openSource', 'export'].map(action => [action, `libraryEvidence:${action}`])
) as Record<'list' | 'detail' | 'create' | 'update' | 'archive' | 'checkSource' | 'openSource' | 'export', string>
export type EvidenceScope = { workspaceId: string; spaceEpoch: string }
export type EvidenceErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'FORMAT_UNSUPPORTED' | 'CORRUPT_DATA' | 'LIMIT_EXCEEDED' | 'SOURCE_MISSING' | 'SOURCE_CHANGED' | 'SOURCE_UNAUTHORIZED' | 'SPACE_CHANGED' | 'MAINTENANCE_BLOCKED' | 'WRITE_FAILED' | 'CANCELED'
export type EvidenceResult<T> = ({ ok: true } & T) | { ok: false; code: EvidenceErrorCode; message: string; currentRevision?: number }
export type EvidenceRelation = 'supports' | 'opposes' | 'mixed' | 'unassessed'
export type EvidenceReviewState = 'draft' | 'checked'
export type EvidenceSourceStatus = 'unchecked' | 'available' | 'unbound' | 'missing' | 'changed' | 'detached' | 'unauthorized'
export interface EvidenceLocator { pageStart?: number; pageEnd?: number; printedPageLabel?: string; section?: string; figureOrTable?: string }
export interface EvidenceFields {
  paperId: string
  projectIds: string[]
  question: string
  claim: string
  quote: string
  method: string
  datasetOrMaterial: string
  finding: string
  limitation: string
  comment: string
  relation: EvidenceRelation
  locator: EvidenceLocator
}
export interface EvidencePaperSnapshot { id: string; title: string; authors: string[]; url: string }
export interface EvidenceDocumentBinding { sha256: string; size: number; checkedAt: string }
export interface EvidenceVersion extends EvidenceFields {
  version: number
  paperSnapshot: EvidencePaperSnapshot
  documentBinding: EvidenceDocumentBinding | null
  reviewState: EvidenceReviewState
  archived: boolean
  updatedAt: string
}
export interface EvidenceCard { id: string; createdAt: string; currentVersion: number; versions: EvidenceVersion[] }
export interface EvidenceDocument { schemaVersion: 1; revision: number; cards: EvidenceCard[] }
export interface EvidenceFilter { projectId?: string; keyword?: string; reviewState?: EvidenceReviewState; archive: 'exclude' | 'only' | 'include'; source: 'all' | 'problem' }
export interface SourceInspection { status: EvidenceSourceStatus; checkedAt?: string; sha256?: string; size?: number }
export interface SourceOpenResult { status: EvidenceSourceStatus; pdfUrl?: string; requestedPage?: number; locationMode: 'manual-page' }
export interface EvidenceCardSummary extends Pick<EvidenceVersion, 'question' | 'method' | 'datasetOrMaterial' | 'finding' | 'limitation' | 'locator' | 'relation' | 'reviewState' | 'archived'> { cardId: string; version: number; sourceStatus: EvidenceSourceStatus; checkedAt?: string }
export interface EvidenceMatrixRow { paperId: string; paperSnapshot: EvidencePaperSnapshot; missingPaper: boolean; missingProjectIds: string[]; cards: EvidenceCardSummary[] }
export interface EvidenceList { scope: EvidenceScope; revision: number; rows: EvidenceMatrixRow[]; total: number; page: number; pageSize: 50 }
export interface EvidenceListRequest { scope?: EvidenceScope; filter: EvidenceFilter; page: number }
export interface EvidenceWriteRequest { scope: EvidenceScope; expectedRevision: number; input: EvidenceFields }
export interface EvidenceCardReply { revision: number; card: EvidenceCard }
export type EvidenceCheckRequest = { scope: EvidenceScope; cardId: string } & ({ mode: 'inspect'; version: number } | { mode: 'confirm'; expectedRevision: number })
export interface EvidenceApi {
  list(request: EvidenceListRequest): Promise<EvidenceResult<EvidenceList>>
  detail(request: { scope: EvidenceScope; cardId: string }): Promise<EvidenceResult<EvidenceCardReply>>
  create(request: EvidenceWriteRequest): Promise<EvidenceResult<EvidenceCardReply>>
  update(request: EvidenceWriteRequest & { cardId: string }): Promise<EvidenceResult<EvidenceCardReply>>
  archive(request: { scope: EvidenceScope; cardId: string; expectedRevision: number; archived: boolean }): Promise<EvidenceResult<EvidenceCardReply>>
  checkSource(request: EvidenceCheckRequest): Promise<EvidenceResult<EvidenceCardReply | { inspection: SourceInspection }>>
  openSource(request: { scope: EvidenceScope; cardId: string; version: number }): Promise<EvidenceResult<{ source: SourceOpenResult }>>
}
