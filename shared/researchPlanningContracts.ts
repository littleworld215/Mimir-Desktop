/** 人工科研计划独立于Agent执行任务；所有持久标识均为空间内标识。 */
export const PLANNING_MAX_BYTES = 16 * 1024 * 1024
export const PLANNING_MAX_ITEMS = 10_000
export const PLANNING_PAGE_SIZE = 50
export type PlanningKind = 'project' | 'direction' | 'todo' | 'schedule' | 'generic' | 'literature'
export type PlanningStatus = 'planned' | 'active' | 'paused' | 'done'
export type PlanningPriority = 'none' | 'low' | 'medium' | 'high'
export interface PlanningScope { workspaceId: string; spaceEpoch: string }
export type PlanningHostKind = 'paper' | 'libraryProject' | 'experiment'
export interface PlanningHostReference { id: string; name: string; exists: boolean }
export type PlanningExportFormat = 'json' | 'markdown' | 'csv' | 'html'
export interface PlanningImportOptions { strategy: 'skip' | 'copy' | 'update'; collections: Record<string, string> }
export interface PlanningImportSelection {
  importId: string; fileName: string; format: string; sha256: string; bytes: number; itemCount: number; typeCount: number; brokenReferenceCount: number
  collections: { id: string; name: string; count: number }[]; warnings: string[]
}
export interface PlanningImportPreview extends PlanningState {
  previewToken: string; counts: { added: number; updated: number; skipped: number; copied: number }; totalAfter: number
  duplicates: { id: string; before: Pick<PlanningItem, 'title' | 'kind' | 'archived' | 'deleted' | 'updatedAt'>; incoming: Pick<PlanningItem, 'title' | 'kind' | 'archived' | 'deleted' | 'updatedAt'>; bodyChanged: boolean }[]
}
export interface PlanningExportPreview extends PlanningState { previewToken: string; format: PlanningExportFormat; sha256: string; bytes: number; itemCount: number; text: string }
export interface PlanningCollection { id: string; name: string; order: number; deleted: boolean }
export interface PlanningType { id: string; name: string; kind: PlanningKind; builtin: boolean; order: number; deleted: boolean }
export interface PlanningField { id: string; name: string; value: string }
export interface PlanningInput {
  kind: PlanningKind; typeId: string; collectionId: string; title: string; content: string; status: PlanningStatus
  important: boolean; archived: boolean; deleted: boolean; priority: PlanningPriority; order: number; fields: PlanningField[]
  projectId: string | null; directionId: string | null; projectCategory: 'vertical' | 'horizontal' | 'other' | null; majorDirection: boolean
  done: boolean; dueDate: string | null; myDay: string | null
  schedule: { date: string; start: string | null; end: string | null } | null
  recurrence: { unit: 'daily' | 'weekly' | 'monthly'; interval: number } | null
  literature: { authors: string[]; year: number | null; doi: string; url: string; readingState: 'unread' | 'reading' | 'read'; paperId: string | null } | null
  libraryProjectId: string | null; experimentIds: string[]
}
export interface PlanningItem extends PlanningInput { id: string; createdAt: string; updatedAt: string; recurrenceParentId?: string }
export interface PlanningDocument { schemaVersion: 1; revision: number; collections: PlanningCollection[]; types: PlanningType[]; items: PlanningItem[] }
export interface PlanningDraft { id: string; itemId: string | null; baseRevision: number; input: PlanningInput; updatedAt: string }
export interface PlanningDraftDocument { schemaVersion: 1; revision: number; drafts: PlanningDraft[] }
export interface PlanningDeliveryDocument { schemaVersion: 1; revision: number; deliveries: { itemId: string; dueDate: string; deliveredAt: string }[] }
export type PlanningErrorCode = 'BAD_REQUEST' | 'CONFLICT' | 'CORRUPT_DATA' | 'UNSUPPORTED_VERSION' | 'LIMIT_EXCEEDED' | 'SOURCE_UNAUTHORIZED' | 'WRITE_FAILED' | 'SPACE_CHANGED' | 'MAINTENANCE_BLOCKED' | 'CANCELED' | 'NOT_FOUND'
export type PlanningResult<T> = ({ ok: true } & T) | { ok: false; code: PlanningErrorCode; message: string; currentRevision?: number }
export interface PlanningFilter {
  keyword?: string; kind?: PlanningKind; typeId?: string; collectionId?: string; projectId?: string; status?: PlanningStatus
  archived?: 'exclude' | 'only' | 'include'; deleted?: boolean; important?: boolean; done?: boolean; myDay?: string
  dateFrom?: string; dateTo?: string
  dueBefore?: string; priority?: PlanningPriority
}
export type PlanningSummaryItem = Pick<PlanningItem, 'id' | 'title' | 'kind' | 'status' | 'done' | 'priority' | 'important' | 'projectId' | 'dueDate' | 'myDay' | 'schedule'>
export interface PlanningSummary {
  counts: { myDay: number; overdue: number; weekEvents: number; activeProjects: number }
  myDay: PlanningSummaryItem[]; overdue: PlanningSummaryItem[]; weekEvents: PlanningSummaryItem[]; activeProjects: PlanningSummaryItem[]
  nextActions: Record<string, PlanningSummaryItem[]>
}
export interface PlanningState { revision: number; scope: PlanningScope }
export interface PlanningWrite { scope: PlanningScope; expectedRevision: number }
export type PlanningCommand =
  | { kind: 'collection'; id?: string; name: string; deleted?: boolean; moveTo?: string }
  | { kind: 'type'; id?: string; name: string; itemKind?: 'generic' | 'todo'; deleted?: boolean; moveTo?: string }
  | { kind: 'bulk'; ids: string[]; patch: { archived?: boolean; deleted?: boolean; collectionId?: string; status?: PlanningStatus; important?: boolean } }
  | { kind: 'duplicate'; id: string }
  | { kind: 'reorder'; ids: string[] }
  | { kind: 'clearCompleted'; collectionId?: string; typeId?: string }
  | { kind: 'completeTodo'; id: string; done: boolean }
  | { kind: 'planTodoDay'; id: string; date: string | null }
export interface PlanningApi {
  bootstrap(request: Record<string, never>): Promise<PlanningResult<PlanningState & { collections: PlanningCollection[]; types: PlanningType[]; total: number }>>
  list(request: { scope: PlanningScope; filter: PlanningFilter; page: number }): Promise<PlanningResult<PlanningState & { items: PlanningItem[]; total: number; page: number; pageSize: 50 }>>
  detail(request: { scope: PlanningScope; itemId: string }): Promise<PlanningResult<PlanningState & { item: PlanningItem }>>
  save(request: PlanningWrite & { itemId?: string; input: PlanningInput }): Promise<PlanningResult<PlanningState & { item: PlanningItem }>>
  mutate(request: PlanningWrite & { command: PlanningCommand; preview?: boolean }): Promise<PlanningResult<PlanningState & { entityId?: string; affectedCount: number; preview: boolean }>>
  summary(request: { scope: PlanningScope; date: string; projectIds?: string[] }): Promise<PlanningResult<PlanningState & PlanningSummary>>
  calendar(request: { scope: PlanningScope; from: string; to: string; filter?: PlanningFilter }): Promise<PlanningResult<PlanningState & { total: number; days: { date: string; total: number; items: PlanningSummaryItem[] }[] }>>
  drafts(request: { scope: PlanningScope }): Promise<PlanningResult<PlanningState & { drafts: PlanningDraft[] }>>
  saveDraft(request: PlanningWrite & { draft: Omit<PlanningDraft, 'updatedAt'> }): Promise<PlanningResult<PlanningState & { draft: PlanningDraft }>>
  removeDraft(request: PlanningWrite & { draftId: string }): Promise<PlanningResult<PlanningState>>
  references(request: { scope: PlanningScope; kind: PlanningHostKind; keyword: string; page: number; ids?: string[] }): Promise<PlanningResult<{ scope: PlanningScope; items: PlanningHostReference[]; total: number; page: number; pageSize: 50 }>>
  selectImport(request: { scope: PlanningScope }): Promise<PlanningResult<{ selection: PlanningImportSelection | null; canceled: boolean }>>
  previewImport(request: PlanningWrite & { importId: string; options: PlanningImportOptions }): Promise<PlanningResult<PlanningImportPreview>>
  applyImport(request: PlanningWrite & { importId: string; previewToken: string }): Promise<PlanningResult<PlanningState & { counts: PlanningImportPreview['counts'] }>>
  importDifference(request: PlanningWrite & { importId: string; previewToken: string; itemId: string }): Promise<PlanningResult<{ before: PlanningItem; incoming: PlanningItem }>>
  exportPreview(request: PlanningWrite & { format: PlanningExportFormat }): Promise<PlanningResult<PlanningExportPreview>>
  saveExport(request: PlanningWrite & { previewToken: string }): Promise<PlanningResult<{ saved: boolean; canceled: boolean; fileName?: string }>>
}
export const PLANNING_CHANNELS: { [K in keyof PlanningApi]: `researchPlanning:${K}` } = {
  bootstrap: 'researchPlanning:bootstrap', list: 'researchPlanning:list', detail: 'researchPlanning:detail', save: 'researchPlanning:save', mutate: 'researchPlanning:mutate', summary: 'researchPlanning:summary', calendar: 'researchPlanning:calendar', drafts: 'researchPlanning:drafts', saveDraft: 'researchPlanning:saveDraft', removeDraft: 'researchPlanning:removeDraft', references: 'researchPlanning:references', selectImport: 'researchPlanning:selectImport', previewImport: 'researchPlanning:previewImport', applyImport: 'researchPlanning:applyImport', importDifference: 'researchPlanning:importDifference', exportPreview: 'researchPlanning:exportPreview', saveExport: 'researchPlanning:saveExport'
}
