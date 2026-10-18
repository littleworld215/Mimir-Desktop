import type { EvidenceErrorCode, EvidenceLocator, EvidenceRelation, EvidenceReviewState, EvidenceScope, EvidenceSourceStatus, EvidenceVersion } from './libraryEvidenceContracts'

/** 研究组织只保存引用，证据正文仍由独立证据域持有。 */
export const RESEARCH_MAX_QUESTIONS = 200
export const RESEARCH_MAX_PACKS = 100
export const RESEARCH_MAX_ITEMS = 500
export const RESEARCH_MAX_BYTES = 16 * 1024 * 1024
export const RESEARCH_PAGE_SIZE = 50
export type ResearchScope = EvidenceScope
export type ResearchErrorCode = EvidenceErrorCode | 'REFERENCE_UNRESOLVED'
export type ResearchResult<T> = ({ ok: true } & T) | { ok: false; code: ResearchErrorCode; message: string; currentRevision?: number; currentEvidenceRevision?: number }
export interface ResearchQuestionVersion {
  version: number; projectId: string; title: string; question: string; note: string
  evidenceCardIds: string[]; archived: boolean; updatedAt: string
}
export interface ResearchPackItem {
  id: string; questionId: string; questionVersion: number; cardId: string; evidenceVersion: number; section: string; note: string
}
export interface ResearchPackVersion {
  version: number; projectId: string; title: string; note: string; items: ResearchPackItem[]; archived: boolean; updatedAt: string
}
export interface ResearchQuestion { id: string; createdAt: string; currentVersion: number; versions: ResearchQuestionVersion[] }
export interface ResearchPack { id: string; createdAt: string; currentVersion: number; versions: ResearchPackVersion[] }
export interface ResearchDocument { schemaVersion: 1; revision: number; questions: ResearchQuestion[]; packs: ResearchPack[] }
export interface ResearchReadState { revision: number; evidenceRevision: number | null; evidenceState: 'absent' | 'available' | 'unreadable' | 'unsupported' }
export interface ResearchWriteBase { scope: ResearchScope; expectedRevision: number; expectedEvidenceRevision?: number }
export interface ResearchQuestionInput { projectId: string; title: string; question: string; note: string; evidenceCardIds: string[] }
export type ResearchPackItemInput = { kind: 'existing'; itemId: string; section: string; note: string } | { kind: 'new'; questionId: string; cardId: string; section: string; note: string }
export interface ResearchPackInput { projectId: string; title: string; note: string; items: ResearchPackItemInput[] }
export interface ResearchFilter { projectId?: string; keyword?: string; archive: 'exclude' | 'only' | 'include' }
export type ResearchPage<T> = ResearchReadState & { items: T[]; total: number; page: number; pageSize: 50 }
export interface ResearchQuestionSummary { id: string; projectId: string; title: string; currentVersion: number; archived: boolean; cardCount: number; problemCount: number | null }
export interface ResearchPackSummary { id: string; projectId: string; title: string; currentVersion: number; archived: boolean; itemCount: number; problemCount: number | null }
export interface ResearchReferenceStatus {
  missingQuestion: boolean; missingEvidence: boolean; missingProject: boolean; questionArchived: boolean; evidenceArchived: boolean
  projectDetached: boolean; removedFromQuestion: boolean; questionHasNewVersion: boolean; evidenceHasNewVersion: boolean
}
export interface ResearchEvidenceRow {
  cardId: string; version: number | null; paperId?: string; paperTitle?: string
  question: string; claim: string; quote: string; method: string; datasetOrMaterial: string; finding: string; limitation: string
  relation: EvidenceRelation | 'unknown'; reviewState: EvidenceReviewState | 'unknown'; locator: EvidenceLocator
  sourceStatus: EvidenceSourceStatus | 'unknown'; checkedAt?: string; problems: string[]
}
export type ResearchQuestionDetail = ResearchReadState & {
  question: ResearchQuestion; selectedVersion: number; rows: ResearchEvidenceRow[]; total: number; page: number; pageSize: 50
  relationCounts: Record<EvidenceRelation | 'unknown', number>
}
export interface ResearchResolvedItem {
  item: ResearchPackItem; status: ResearchReferenceStatus; question?: ResearchQuestionVersion; evidence?: EvidenceVersion
  sourceStatus: EvidenceSourceStatus | 'unknown'; checkedAt?: string
}
export type ResearchPackDetail = ResearchReadState & { pack: ResearchPack; selectedVersion: number; items: ResearchResolvedItem[] }
export type ResearchRefreshPreview = ResearchReadState & {
  packId: string; packVersion: number; previewToken: string
  changes: { itemId: string; eligible: boolean; reason?: string; before: ResearchResolvedItem; after?: ResearchResolvedItem }[]
}
export type ResearchExportPreview = ResearchReadState & {
  packId: string; packVersion: number; markdown: string; entryCount: number; uniqueCardCount: number; problemCount: number
  previewToken: string; saved: boolean; canceled?: boolean; fileName?: string
}
export type ResearchQuestionReply = ResearchReadState & { question: ResearchQuestion }
export type ResearchPackReply = ResearchReadState & { pack: ResearchPack }
export interface ResearchApi {
  overview(request: { scope?: ResearchScope }): Promise<ResearchResult<ResearchReadState & { scope: ResearchScope; questionCount: number; packCount: number }>>
  listQuestions(request: { scope: ResearchScope; filter: ResearchFilter; page: number }): Promise<ResearchResult<ResearchPage<ResearchQuestionSummary>>>
  questionDetail(request: { scope: ResearchScope; questionId: string; version?: number; page: number; keyword?: string; relation?: EvidenceRelation }): Promise<ResearchResult<ResearchQuestionDetail>>
  saveQuestion(request: ResearchWriteBase & { questionId?: string; input: ResearchQuestionInput }): Promise<ResearchResult<ResearchQuestionReply>>
  archiveQuestion(request: ResearchWriteBase & { questionId: string; archived: boolean }): Promise<ResearchResult<ResearchQuestionReply>>
  listEvidence(request: { scope: ResearchScope; projectId: string; keyword?: string; relation?: EvidenceRelation; page: number }): Promise<ResearchResult<ResearchPage<ResearchEvidenceRow>>>
  listPacks(request: { scope: ResearchScope; filter: ResearchFilter; page: number }): Promise<ResearchResult<ResearchPage<ResearchPackSummary>>>
  packDetail(request: { scope: ResearchScope; packId: string; version?: number }): Promise<ResearchResult<ResearchPackDetail>>
  savePack(request: ResearchWriteBase & { packId?: string; input: ResearchPackInput }): Promise<ResearchResult<ResearchPackReply>>
  archivePack(request: ResearchWriteBase & { packId: string; archived: boolean }): Promise<ResearchResult<ResearchPackReply>>
  previewRefresh(request: ResearchWriteBase & { packId: string; itemIds: string[] }): Promise<ResearchResult<ResearchRefreshPreview>>
  applyRefresh(request: ResearchWriteBase & { packId: string; itemIds: string[]; previewToken: string }): Promise<ResearchResult<ResearchPackReply>>
  export(request: { scope: ResearchScope; packId: string; packVersion: number; expectedRevision: number; expectedEvidenceRevision: number; mode: 'preview' | 'save'; previewToken?: string }): Promise<ResearchResult<ResearchExportPreview>>
}
export const RESEARCH_CHANNELS: { [K in keyof ResearchApi]: `libraryResearch:${K}` } = {
  overview: 'libraryResearch:overview', listQuestions: 'libraryResearch:listQuestions', questionDetail: 'libraryResearch:questionDetail',
  saveQuestion: 'libraryResearch:saveQuestion', archiveQuestion: 'libraryResearch:archiveQuestion', listEvidence: 'libraryResearch:listEvidence',
  listPacks: 'libraryResearch:listPacks', packDetail: 'libraryResearch:packDetail', savePack: 'libraryResearch:savePack',
  archivePack: 'libraryResearch:archivePack', previewRefresh: 'libraryResearch:previewRefresh', applyRefresh: 'libraryResearch:applyRefresh', export: 'libraryResearch:export'
}
