/**
 * 资产域（assets）跨进程契约 —— **纯类型 / DTO**。
 *
 * 约束（见 docs/INTEGRATION-PLAN-I0-I1.md §3.3）：
 * - 本文件**只允许**类型与纯常量，**不得** import Electron / better-sqlite3 / node:fs，
 *   以便主进程（electron/）与渲染层（src/）共享同一份合同。
 * - DB 列 snake_case，DTO camelCase；ID 为正 safe integer；时间为主进程生成的 UTC ISO 字符串。
 * - 成功 / 失败用判别联合 `AssetsResult<T>` 表达，**不向渲染层抛异常**。
 *
 * 本文件由 tsconfig.node.json 与 tsconfig.web.json 同时 include。
 */

import type { AssetsAiApi } from './assetsAiContracts'

export type StorageType = 'inline_text' | 'file' | 'external_link'

export type AssetKind = 'thought' | 'rule' | 'file' | 'prompt'

export type ArchiveScope = 'exclude' | 'only' | 'include'

export type TagMode = 'and' | 'or'

/** 资产域统一错误码（IPC 捕获业务错误后回传，未知异常另行兜底）。 */
export type AssetsErrorCode =
  | 'BAD_REQUEST'
  | 'APPROVAL_DENIED'
  | 'AI_NO_MODEL'
  | 'AI_ABORTED'
  | 'AI_TIMEOUT'
  | 'AI_FAILED'
  | 'AI_EMPTY_RESULT'
  | 'PREVIEW_STALE'
  | 'NOT_FOUND'
  | 'DUPLICATE_CODE'
  | 'BAD_CATEGORY'
  | 'BAD_KIND'
  | 'BAD_TEMPLATE_CONFIG'
  | 'CYCLE'
  | 'HAS_CHILDREN'
  | 'CATEGORY_IN_USE'
  | 'BUILTIN_PROTECTED'
  | 'TAG_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'SPACE_CHANGED'
  | 'NO_ACTIVE_WORKSPACE'
  | 'ASSET_ARCHIVED'
  | 'FILE_UNAVAILABLE'
  | 'FILE_EXISTS'
  | 'PATH_REJECTED'
  | 'STORE_CORRUPT'
  | 'SCHEMA_UNSUPPORTED'
  | 'NATIVE_BINDING_UNAVAILABLE'
  | 'WRITE_FAILED'

/** 判别联合：成功携带业务字段，失败携带 code / message 与可选冲突上下文。 */
export type AssetsResult<T extends object> =
  | ({ ok: true } & T)
  | {
      ok: false
      code: AssetsErrorCode
      message: string
      details?: { currentRevision?: number; currentVersionId?: number | null }
    }

/** 每个 assets 请求都携带的可信空间作用域（由主进程 assets:context 下发）。 */
export interface WorkspaceRequest {
  workspaceId: string
  spaceEpoch: string
}

export interface AssetRef extends WorkspaceRequest {
  assetId: number
}

/** 条件写：防止用过期表单覆盖他人修改。 */
export interface WriteCondition {
  expectedRevision: number
  /** 仅正文编辑需要；缺省表示不校验当前版本指针。 */
  expectedCurrentVersionId?: number | null
}

/**
 * 变量输入类型（与来源 shared/src/template-config.ts 的 `VariableInputType` 对齐）。
 * 注意：来源用 `single` / `multi`，**没有** `select` / `multiselect`。
 */
export type VariableInputType = 'text' | 'textarea' | 'single' | 'multi'

/**
 * 变量配置（PromptDock，与来源 shared/src/template-config.ts 语义一致，I4 才编辑 UI）。
 *
 * 与来源对齐：`type` **必填**；仅 `type` / `options` / `separator` 三个键；
 * **没有** `defaultValue`（来源已移除）。
 */
export interface TemplateConfigVariable {
  type: VariableInputType
  options?: string[]
  separator?: string
}

export interface TemplateConfig {
  version: 1
  variables: Record<string, TemplateConfigVariable>
}

export interface TemplateVariable { name: string; defaultValue: string }
export type TemplateValues = Record<string, string | string[]>
export type TaskPackSectionKey = 'thought' | 'rule' | 'prompt' | 'file' | 'ordinary'
export interface TaskPackTemplate {
  includeHeader: boolean
  includeSource: boolean
  includeNotes: boolean
  includeTags: boolean
  sections: Array<{key:TaskPackSectionKey;title:string}>
}
export interface TaskPackResult { text:string; assetIds:number[]; excludedIds:number[] }

export interface AssetCreateInput {
  code?: string
  name: string
  category: string
  storageType: StorageType
  content?: string
  externalUrl?: string
  description?: string
  sourceTask?: string
  notes?: string
  kind?: AssetKind | null
  source?: Record<string, unknown>
  templateConfig?: TemplateConfig
  tagNames?: string[]
  changelog?: string
}

export type AssetPatch = Partial<Omit<AssetCreateInput, 'code' | 'storageType'>>

/** Portable exchange carries no SQLite identities, managed paths or binary bytes. */
export interface ExchangeAsset {
  code: string
  name: string
  category: string
  categoryPath: string[]
  description: string
  storageType: StorageType
  externalUrl: string | null
  sourceJson: string
  sourceTask: string
  notes: string
  kind: AssetKind | null
  templateConfig: TemplateConfig
  tags: Array<{ name: string; color: string | null }>
  references: string[]
  content: string | null
  contentVersion: number | null
  currentFileName: string | null
  isFavorite: 0 | 1
  lastUsedAt: string | null
  archivedAt: string | null
  aiGenerated?: true
}
export interface ExchangeDocument { exportedAt: string; count: number; assets: ExchangeAsset[] }
export type AssetExportQuery = Omit<AssetListQuery, 'page' | 'pageSize' | 'ids'>
export interface AssetExportRequest {
  format?: 'json' | 'markdown'
  query?: AssetExportQuery
  ids?: number[]
  ai?: 'include' | 'original-only'
}
export interface AssetExportResult { format: 'json' | 'markdown'; count: number; fileName: string; content: string }
/** Mirrors the source application's transfer-file limit; never silently truncates. */
export const ASSET_TRANSFER_MAX_BYTES = 200 * 1024 * 1024

export type AssetImportMode = 'skip' | 'overwrite' | 'copy'
export interface AssetImportRequest { raw: string; mode?: AssetImportMode; skipIndexes?: number[] }
export interface AssetImportRowPreview {
  index: number
  code: string
  targetCode: string
  action: 'create' | 'update' | 'skip' | 'error'
  before: ExchangeAsset | null
  after: ExchangeAsset | null
  warnings: string[]
}
export interface AssetImportPreview {
  previewToken: string
  canCommit: boolean
  created: number
  updated: number
  skipped: number
  filesMissing: number
  categoriesMissing: string[]
  referencesMissing: string[]
  errors: Array<{ index: number; message: string }>
  duplicates: Array<{ index: number; code: string; matches: string[] }>
  rows: AssetImportRowPreview[]
}
export interface AssetImportResult { created: number; updated: number; skipped: number; assetIds: number[] }

export interface AssetBatchRequest {
  assets: Array<{ assetId: number; expectedRevision: number }>
  category?: string
  addTagNames?: string[]
  removeTagIds?: number[]
}
export interface AssetBatchPreview {
  previewToken: string
  changed: number
  rows: Array<{ assetId: number; name: string; beforeCategory: string; afterCategory: string; beforeTags: string[]; afterTags: string[] }>
}
export interface AssetBatchResult { changed: number; assetIds: number[] }
export interface AssetFolderOptions { category?:string;tagNames?:string[] }
export interface AssetPromptAdaptation {raw:string;changes:Array<{name:string;before:string;after:string;warnings:string[]}>;warnings:string[]}
export interface AssetFolderQueue {
  queueId:string
  total:number
  completed:number
  entries:Array<{index:number;name:string;state:'pending'|'processing'|'done'|'failed';error?:string;assetId?:number}>
}

export interface AssetListQuery {
  q?: string
  searchIn?: 'all' | 'title' | 'body' | 'source' | 'organization'
  sort?: 'relevance' | 'updated' | 'name' | 'recent'
  view?: 'all' | 'favorites' | 'recent'
  updatedAfter?: string
  excludeTagIds?: number[]
  ids?: number[]
  page?: number
  pageSize?: number
  category?: string
  kind?: AssetKind | null
  tagIds?: number[]
  tagMode?: TagMode
  storageType?: StorageType
  archived?: ArchiveScope
}

/** Saved queries contain filters only, never a page or a selected asset set. */
export interface SavedAssetFilter {
  id: number
  name: string
  query: Omit<AssetListQuery, 'page' | 'pageSize' | 'ids'>
  revision: number
  createdAt: string
  updatedAt: string
}

export interface AssetTag {
  id: number
  name: string
  color: string | null
  revision: number
}

export interface AssetVersionSummary {
  id: number
  assetId: number
  version: number
  filePath: string | null
  fileName: string | null
  changelog: string
  createdAt: string
}

export interface AssetVersion extends AssetVersionSummary {
  content: string
  sourceJson: string
}

export interface AssetCategory {
  code: string
  name: string
  icon: string | null
  defaultStorageType: StorageType | null
  description: string
  builtin: boolean
  parentCode: string | null
  sortOrder: number
  revision: number
  createdAt: string
  /** 仅 list 时给出：该分类（不含子树）下未归档资产数。 */
  assetCount?: number
}

export interface AssetDetail {
  id: number
  code: string
  name: string
  category: string
  categoryPath: string[]
  description: string
  storageType: StorageType
  externalUrl: string | null
  sourceJson: string
  sourceTask: string
  notes: string
  kind: AssetKind | null
  templateConfig: TemplateConfig
  currentVersionId: number | null
  currentVersion: number | null
  currentContent: string
  isFavorite: 0 | 1
  lastUsedAt: string | null
  archivedAt: string | null
  revision: number
  createdAt: string
  updatedAt: string
  versionCount: number
  tags: AssetTag[]
  /** file 形态：当前版本文件是否仍存在。 */
  fileAvailable: boolean
  currentFileName: string | null
}

/** 列表行：不含正文，避免一次载入全部内容。 */
export interface AssetSummary {
  isFavorite?: 0 | 1
  lastUsedAt?: string | null
  /** Plain text only; matches use JavaScript UTF-16 offsets, not code point offsets. */
  excerpt?: { text: string; matches: Array<{ start: number; end: number }> }
  id: number
  code: string
  name: string
  category: string
  categoryPath: string[]
  description: string
  storageType: StorageType
  kind: AssetKind | null
  currentVersion: number | null
  archivedAt: string | null
  revision: number
  updatedAt: string
  tags: AssetTag[]
}

export interface AssetPage {
  items: AssetSummary[]
  total: number
  page: number
  pageSize: number
}

export interface AssetReferences {
  assetId: number
  revision: number
  references: AssetSummary[]
  referencedBy: AssetSummary[]
}
export interface AssetReferenceEdge { sourceAssetId: number; targetAssetId: number }
export interface AssetReferenceGraph {
  rootId: number
  depth: number
  nodes: AssetSummary[]
  edges: AssetReferenceEdge[]
  truncated: boolean
}
export interface AssetReferenceWrite extends WorkspaceRequest, AssetReferenceEdge { expectedRevision: number }
export interface AssetReferenceChange { changed: boolean; revision: number }

export interface VersionPage {
  items: AssetVersionSummary[]
  total: number
  page: number
  pageSize: number
}

export interface VersionDiffLine {
  kind: 'context' | 'add' | 'remove'
  text: string
}

export interface VersionDiff {
  kind: 'text' | 'file'
  fromVersion: number
  toVersion: number
  lines: VersionDiffLine[]
  /** 超过计算预算线性替换，超过行对象预算返回完整原文；字段可选以兼容旧调用。 */
  mode?: 'lcs' | 'replacement' | 'originals'
  beforeText?: string
  afterText?: string
  files?: { from: VersionFileMetadata; to: VersionFileMetadata }
}

export interface VersionFileMetadata {
  fileName: string | null
  /** 缺失、非法或不可读时为 null，不伪造 0 字节。 */
  fileBytes: number | null
  available: boolean
}

export interface CategoryCreate {
  code?: string
  name: string
  parentCode?: string | null
  icon?: string | null
  defaultStorageType?: StorageType | null
  description?: string
  sortOrder?: number
}

export type CategoryPatch = Partial<Omit<CategoryCreate, 'code'>>

export interface CategoryImpact {
  code: string
  /** 含子树与归档资产的影响面。 */
  assetCount: number
  childCount: number
  builtin: boolean
}

export interface TagInput {
  id?: number
  name?: string
}

export interface TagImpact {
  tagId: number
  assetCount: number
  /** rename 且目标名已存在时为该冲突标签 id。 */
  conflictTagId?: number
}

export interface AssetDeleteImpact {
  assetId: number
  name: string
  storageType: StorageType
  archived: boolean
  versionCount: number
  fileCount: number
  fileBytes: number
  revision: number
}

/** 渲染层可见的资产域 API（preload 暴露为 window.electronAPI.assets）。 */
export interface AssetsApi extends AssetsAiApi {
  setFavorite(req: AssetRef & {favorite:boolean}):Promise<AssetsResult<{favorite:boolean}>>
  recordUsage(req:WorkspaceRequest & {assetIds:number[]}):Promise<AssetsResult<{recordedAt:string}>>
  listSavedFilters(req:WorkspaceRequest):Promise<AssetsResult<{filters:SavedAssetFilter[]}>>
  createSavedFilter(req:WorkspaceRequest & {name:string;query:AssetListQuery}):Promise<AssetsResult<{filter:SavedAssetFilter}>>
  updateSavedFilter(req:WorkspaceRequest & {filterId:number;expectedRevision:number;name:string;query:AssetListQuery}):Promise<AssetsResult<{filter:SavedAssetFilter}>>
  deleteSavedFilter(req:WorkspaceRequest & {filterId:number;expectedRevision:number}):Promise<AssetsResult<{deletedId:number}>>
  adaptPromptImport(req:WorkspaceRequest & {raw:string;convertVariables:boolean}):Promise<AssetsResult<{adaptation:AssetPromptAdaptation}>>
  scanFolder(req:WorkspaceRequest & AssetFolderOptions & { folderPath:string }):Promise<AssetsResult<{queue:AssetFolderQueue}>>
  nextFolderFile(req:WorkspaceRequest & {queueId:string;retryFailed?:boolean}):Promise<AssetsResult<{queue:AssetFolderQueue}>>
  cancelFolder(req:WorkspaceRequest & {queueId:string}):Promise<AssetsResult<{canceled:true}>>
  previewBatch(req: WorkspaceRequest & AssetBatchRequest): Promise<AssetsResult<{ preview: AssetBatchPreview }>>
  commitBatch(req: WorkspaceRequest & AssetBatchRequest & { previewToken:string }): Promise<AssetsResult<{ result: AssetBatchResult }>>
  readExchangeFile(req: WorkspaceRequest & { sourcePath:string }): Promise<AssetsResult<{ raw:string }>>
  saveExchange(req: WorkspaceRequest & AssetExportRequest & { destinationPath:string }): Promise<AssetsResult<{ saved:true;count:number }>>
  exportAssets(req: WorkspaceRequest & AssetExportRequest): Promise<AssetsResult<{ result: AssetExportResult }>>
  previewImport(req: WorkspaceRequest & AssetImportRequest): Promise<AssetsResult<{ preview: AssetImportPreview }>>
  importJson(req: WorkspaceRequest & AssetImportRequest & { previewToken: string }): Promise<AssetsResult<{ result: AssetImportResult }>>
  references(req: AssetRef): Promise<AssetsResult<{ references: AssetReferences }>>
  addReference(req: AssetReferenceWrite): Promise<AssetsResult<AssetReferenceChange>>
  removeReference(req: AssetReferenceWrite): Promise<AssetsResult<AssetReferenceChange>>
  referenceGraph(req: AssetRef & { depth?: number }): Promise<AssetsResult<{ graph: AssetReferenceGraph }>>
  context(): Promise<AssetsResult<{ context: WorkspaceRequest }>>
  list(req: WorkspaceRequest & AssetListQuery): Promise<AssetsResult<{ page: AssetPage }>>
  get(req: AssetRef): Promise<AssetsResult<{ asset: AssetDetail }>>
  create(
    req: WorkspaceRequest & { input: AssetCreateInput }
  ): Promise<AssetsResult<{ asset: AssetDetail }>>
  update(
    req: AssetRef & WriteCondition & { patch: AssetPatch }
  ): Promise<AssetsResult<{ asset: AssetDetail }>>
  archive(
    req: AssetRef & { expectedRevision: number }
  ): Promise<AssetsResult<{ asset: AssetDetail; changed: boolean }>>
  restore(
    req: AssetRef & { expectedRevision: number }
  ): Promise<AssetsResult<{ asset: AssetDetail; changed: boolean }>>
  deletePreview(req: AssetRef): Promise<AssetsResult<{ impact: AssetDeleteImpact }>>
  delete(
    req: AssetRef & { expectedRevision: number; confirm: true }
  ): Promise<AssetsResult<{ deletedId: number; cleanupPending: boolean }>>
  importFile(
    req: AssetRef & WriteCondition & { sourcePath: string; changelog?: string }
  ): Promise<AssetsResult<{ asset: AssetDetail }>>
  saveFile(
    req: AssetRef & { versionId?: number; destinationPath: string }
  ): Promise<AssetsResult<{ saved: boolean }>>
  listVersions(
    req: AssetRef & { page?: number; pageSize?: number }
  ): Promise<AssetsResult<{ page: VersionPage }>>
  getVersion(req: AssetRef & { versionId: number }): Promise<AssetsResult<{ version: AssetVersion }>>
  diffVersions(
    req: AssetRef & { fromVersionId: number; toVersionId: number }
  ): Promise<AssetsResult<{ diff: VersionDiff }>>
  rollbackVersion(
    req: AssetRef & WriteCondition & { versionId: number }
  ): Promise<AssetsResult<{ asset: AssetDetail; createdVersion: AssetVersion }>>
  listCategories(
    req: WorkspaceRequest & { archived?: ArchiveScope }
  ): Promise<AssetsResult<{ categories: AssetCategory[] }>>
  createCategory(
    req: WorkspaceRequest & { input: CategoryCreate }
  ): Promise<AssetsResult<{ category: AssetCategory }>>
  updateCategory(
    req: WorkspaceRequest & { code: string; expectedRevision: number; patch: CategoryPatch }
  ): Promise<AssetsResult<{ category: AssetCategory }>>
  categoryImpact(
    req: WorkspaceRequest & { code: string }
  ): Promise<AssetsResult<{ impact: CategoryImpact }>>
  deleteCategory(
    req: WorkspaceRequest & { code: string; expectedRevision: number; confirm: true }
  ): Promise<AssetsResult<{ deletedCode: string }>>
  listTags(req: WorkspaceRequest): Promise<AssetsResult<{ tags: AssetTag[] }>>
  createTag(
    req: WorkspaceRequest & { name: string; color?: string }
  ): Promise<AssetsResult<{ tag: AssetTag; created: boolean }>>
  addTags(
    req: AssetRef & { expectedRevision: number; tags: TagInput[] }
  ): Promise<AssetsResult<{ asset: AssetDetail }>>
  removeTags(
    req: AssetRef & { expectedRevision: number; tagIds: number[] }
  ): Promise<AssetsResult<{ asset: AssetDetail }>>
  tagImpact(
    req: WorkspaceRequest & { tagId: number; targetName?: string }
  ): Promise<AssetsResult<{ impact: TagImpact }>>
  renameTag(
    req: WorkspaceRequest & { tagId: number; expectedRevision: number; name: string }
  ): Promise<AssetsResult<{ tag: AssetTag }>>
  mergeTags(
    req: WorkspaceRequest & {
      sourceId: number
      targetId: number
      expectedSourceRevision: number
      expectedTargetRevision: number
      confirm: true
    }
  ): Promise<AssetsResult<{ target: AssetTag }>>
  deleteTag(
    req: WorkspaceRequest & { tagId: number; expectedRevision: number; confirm: true }
  ): Promise<AssetsResult<{ deletedId: number }>>
}

/** 分页默认与上限（服务端校验）。 */
export const ASSETS_PAGE_DEFAULT = 50
export const ASSETS_PAGE_MIN = 1
export const ASSETS_PAGE_MAX = 200

/** 写入上限（服务端校验，UI 预检查不能替代）。 */
export const ASSET_NAME_MAX = 200
export const ASSET_CODE_MAX = 100
export const TAG_NAME_MAX = 80
export const ASSET_MAX_TAGS = 100
export const ASSET_CONTENT_MAX_BYTES = 5 * 1024 * 1024
export const ASSET_FILE_MAX_BYTES = 200 * 1024 * 1024
export const ASSET_SOURCE_JSON_MAX_BYTES = 64 * 1024

/** assets:<method> IPC 通道名（preload 逐方法固定 invoke，不暴露任意通道）。 */
export const ASSETS_CHANNELS = {
  generateAiDraft: 'assets:generateAiDraft',
  suggestAiTags: 'assets:suggestAiTags',
  cancelAiRequest: 'assets:cancelAiRequest',
  listAiDrafts: 'assets:listAiDrafts',
  getAiDraft: 'assets:getAiDraft',
  adoptAiDraft: 'assets:adoptAiDraft',
  discardAiDraft: 'assets:discardAiDraft',
  adoptSuggestedTags: 'assets:adoptSuggestedTags',
  setFavorite:'assets:setFavorite',
  recordUsage:'assets:recordUsage',
  listSavedFilters:'assets:listSavedFilters',
  createSavedFilter:'assets:createSavedFilter',
  updateSavedFilter:'assets:updateSavedFilter',
  deleteSavedFilter:'assets:deleteSavedFilter',
  adaptPromptImport:'assets:adaptPromptImport',
  scanFolder:'assets:scanFolder',
  nextFolderFile:'assets:nextFolderFile',
  cancelFolder:'assets:cancelFolder',
  previewBatch:'assets:previewBatch',
  commitBatch:'assets:commitBatch',
  readExchangeFile:'assets:readExchangeFile',
  saveExchange:'assets:saveExchange',
  exportAssets: 'assets:exportAssets',
  previewImport: 'assets:previewImport',
  importJson: 'assets:importJson',
  references: 'assets:references',
  addReference: 'assets:addReference',
  removeReference: 'assets:removeReference',
  referenceGraph: 'assets:referenceGraph',
  context: 'assets:context',
  list: 'assets:list',
  get: 'assets:get',
  create: 'assets:create',
  update: 'assets:update',
  archive: 'assets:archive',
  restore: 'assets:restore',
  deletePreview: 'assets:deletePreview',
  delete: 'assets:delete',
  importFile: 'assets:importFile',
  saveFile: 'assets:saveFile',
  listVersions: 'assets:listVersions',
  getVersion: 'assets:getVersion',
  diffVersions: 'assets:diffVersions',
  rollbackVersion: 'assets:rollbackVersion',
  listCategories: 'assets:listCategories',
  createCategory: 'assets:createCategory',
  updateCategory: 'assets:updateCategory',
  categoryImpact: 'assets:categoryImpact',
  deleteCategory: 'assets:deleteCategory',
  listTags: 'assets:listTags',
  createTag: 'assets:createTag',
  addTags: 'assets:addTags',
  removeTags: 'assets:removeTags',
  tagImpact: 'assets:tagImpact',
  renameTag: 'assets:renameTag',
  mergeTags: 'assets:mergeTags',
  deleteTag: 'assets:deleteTag'
} as const

export type AssetsChannel = (typeof ASSETS_CHANNELS)[keyof typeof ASSETS_CHANNELS]
