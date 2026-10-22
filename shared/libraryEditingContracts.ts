import type { PaperRecord } from './libraryPaperRecord'

export type EditingKind = 'notes' | 'tags' | 'append'
export interface EditingScope { workspaceId: string; spaceEpoch: string }
export interface EditingFields { notes?: string; tags?: string[] }
export interface CommitIntent { commitId: string; draftIds: string[]; base: EditingFields; result: EditingFields; preparedAt: string }
export interface EditingDraft { id: string; paperId: string; kind: EditingKind; base: EditingFields; input: string; revision: number; updatedAt: string; intent?: CommitIntent }
export interface EditingDocument { schemaVersion: 1; revision: number; drafts: EditingDraft[] }
export type EditingStatus = 'editable' | 'missing' | 'trashed' | 'conflict' | 'already-saved'
export interface DraftSummary { id: string; paperId: string; kind: EditingKind; revision: number; updatedAt: string; status: EditingStatus }
export interface SessionWrite { sessionId: string; expectedRevision: number; sequence: number; input: string }
export interface CommitReply { paper: PaperRecord; state: 'saved' | 'already-saved'; cleanup: 'done' | 'pending'; warning?: string }
export type EditingErrorCode = 'BAD_REQUEST' | 'CONFLICT' | 'CORRUPT_DATA' | 'UNSUPPORTED_VERSION' | 'LIMIT_EXCEEDED' | 'SOURCE_UNAUTHORIZED' | 'WRITE_FAILED' | 'SPACE_CHANGED' | 'SESSION_CLOSED' | 'MAINTENANCE_BLOCKED' | 'CANCELED'
export type EditingResult<T> = ({ ok: true } & T) | { ok: false; code: EditingErrorCode; message: string }
export interface EditingOpenReply { base: EditingFields; existing: DraftSummary[]; sessionId?: string; revision: number }
export interface EditingFallbackRequest { paperId: string; base: EditingFields; fields?: EditingFields; appendInput?: string }
export interface LibraryEditingApi {
  list(request?: Record<string, never>): Promise<EditingResult<{ scope: EditingScope; drafts: DraftSummary[] }>>
  detail(request: { scope: EditingScope; id: string }): Promise<EditingResult<{ draft: EditingDraft; status: EditingStatus }>>
  open(request: { scope: EditingScope; paperId: string; kind: EditingKind; resume?: { draftId: string; revision: number } }): Promise<EditingResult<EditingOpenReply>>
  saveDraft(request: { scope: EditingScope; write: SessionWrite }): Promise<EditingResult<{ draft: EditingDraft }>>
  commit(request: { scope: EditingScope; writes: SessionWrite[] }): Promise<EditingResult<CommitReply>>
  discard(request: { scope: EditingScope; id: string; revision: number; sessionId?: string }): Promise<EditingResult<Record<string, never>>>
  close(request: { scope: EditingScope; sessionId: string }): Promise<EditingResult<Record<string, never>>>
  saveWithoutRecovery(request: { scope: EditingScope } & EditingFallbackRequest): Promise<EditingResult<{ paper: PaperRecord }>>
}
