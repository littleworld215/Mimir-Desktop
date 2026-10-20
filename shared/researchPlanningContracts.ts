/** 人工科研计划独立于Agent执行任务；所有持久标识均为空间内标识。 */
export const PLANNING_MAX_BYTES = 16 * 1024 * 1024
export const PLANNING_MAX_ITEMS = 10_000
export const PLANNING_PAGE_SIZE = 50
export type PlanningKind = 'project' | 'direction' | 'todo' | 'schedule' | 'generic' | 'literature'
export type PlanningStatus = 'planned' | 'active' | 'paused' | 'done'
export type PlanningPriority = 'none' | 'low' | 'medium' | 'high'
export interface PlanningScope { workspaceId: string; spaceEpoch: string }
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
export interface PlanningItem extends PlanningInput { id: string; createdAt: string; updatedAt: string }
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
}
export interface PlanningState { revision: number; scope: PlanningScope }
export interface PlanningWrite { scope: PlanningScope; expectedRevision: number }
export type PlanningCommand =
  | { kind: 'collection'; id?: string; name: string; deleted?: boolean; moveTo?: string }
  | { kind: 'type'; id?: string; name: string; itemKind?: 'generic' | 'todo'; deleted?: boolean; moveTo?: string }
  | { kind: 'bulk'; ids: string[]; patch: { archived?: boolean; deleted?: boolean; collectionId?: string; status?: PlanningStatus; important?: boolean } }
  | { kind: 'duplicate'; id: string }
  | { kind: 'reorder'; ids: string[] }
  | { kind: 'clearCompleted' }
export interface PlanningApi {
  bootstrap(request: Record<string, never>): Promise<PlanningResult<PlanningState & { collections: PlanningCollection[]; types: PlanningType[]; total: number }>>
  list(request: { scope: PlanningScope; filter: PlanningFilter; page: number }): Promise<PlanningResult<PlanningState & { items: PlanningItem[]; total: number; page: number; pageSize: 50 }>>
  detail(request: { scope: PlanningScope; itemId: string }): Promise<PlanningResult<PlanningState & { item: PlanningItem }>>
  save(request: PlanningWrite & { itemId?: string; input: PlanningInput }): Promise<PlanningResult<PlanningState & { item: PlanningItem }>>
  mutate(request: PlanningWrite & { command: PlanningCommand; preview?: boolean }): Promise<PlanningResult<PlanningState & { entityId?: string; affectedCount: number; preview: boolean }>>
}
export const PLANNING_CHANNELS: { [K in keyof PlanningApi]: `researchPlanning:${K}` } = {
  bootstrap: 'researchPlanning:bootstrap', list: 'researchPlanning:list', detail: 'researchPlanning:detail', save: 'researchPlanning:save', mutate: 'researchPlanning:mutate'
}
