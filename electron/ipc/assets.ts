/**
 * 资产库 IPC 域（`assets:*`）。
 *
 * I1-08 接通完整合同：资产、分类、标签治理、归档与文件版本，列表返回真实分页摘要。
 *
 * 纪律（与其它 IPC 域一致）：
 * - 返回值统一判别联合 `{ ok: true, ... } | { ok: false, code, message }`，**不向渲染层抛异常**；
 * - 业务错误回传 `AssetsStoreError.code`；未知异常记主进程日志并回有意义的提示，
 *   不泄漏 SQL / 堆栈 / 凭据；
 * - 导入严格校验已选文件，导出领取一次性原生保存授权；均在 try 内捕获错误。
 */
import { ipcMain } from 'electron'
import {
  ASSETS_CHANNELS,
  ASSETS_PAGE_DEFAULT,
  ASSETS_PAGE_MAX,
  ASSETS_PAGE_MIN
} from '../../shared/assetsContracts'
import type { ArchiveScope, AssetsErrorCode, WorkspaceRequest } from '../../shared/assetsContracts'
import { assetsStoreManager } from '../assets/store'
import { setFavorite, recordUsage, listSavedFilters, createSavedFilter, updateSavedFilter, deleteSavedFilter } from '../assets/collectionService'
import { AssetsStoreError, type AssetsContext } from '../assets/types'
import { createAsset, getAsset, listAssets, updateAsset } from '../assets/assetService'
import { getReferences, addReference, removeReference, getReferenceGraph } from '../assets/referenceService'
import { exportAssets } from '../assets/exchangeExport'
import { previewImport, commitImport } from '../assets/exchangeImport'
import { previewBatch, commitBatch } from '../assets/batchService'
import { readExchangeFile, saveExchange } from '../assets/exchangeFiles'
import { scanFolder, nextFolderFile, cancelFolder } from '../assets/folderImport'
import { adaptPromptImport } from '../assets/promptImport'
import { archiveAsset, restoreAsset, deletePreview, deleteAsset } from '../assets/archiveService'
import { listCategories, createCategory, updateCategory, categoryImpact, removeCategory } from '../assets/categoryService'
import { listTags, createTag, addTags, removeTags, tagImpact, renameTag, mergeTags, deleteTag } from '../assets/tagService'
import { assertPositiveId, AssetsValidationError } from '../assets/validation'
import {
  importFile,
  saveFile,
  listVersions,
  getVersion,
  diffVersions,
  rollbackVersion
} from '../assets/fileService'
import { assertRendererPath, assertRendererFilePath, pickedPaths, claimAssetSavePath, type AssetSaveLease } from './rendererPathGuards'
import { resolve } from 'node:path'
import log from '../logger'

type Failure = {
  ok: false
  code: AssetsErrorCode
  message: string
  details?: { currentRevision?: number; currentVersionId?: number | null }
}

/** 业务错误回传 code（含冲突上下文）；未知异常兜底为 WRITE_FAILED 并落日志（不外泄细节）。 */
function failure(error: unknown): Failure {
  if (error instanceof AssetsStoreError) {
    if ('cause' in error) log.error('[assets] 文件生命周期故障：', error)
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  }
  // 校验层错误（assertPositiveId / readPositiveInt 等）属 BAD_REQUEST，不应降级为 WRITE_FAILED。
  if (error instanceof AssetsValidationError) {
    return { ok: false, code: 'BAD_REQUEST', message: error.message }
  }
  log.error('[assets] 未预期的错误：', error)
  return {
    ok: false,
    code: 'WRITE_FAILED',
    message: '资产库操作失败，请重试；若持续失败请查看运行日志。'
  }
}

/** 校验渲染层传入的 workspace 作用域（必须是两个非空字符串）。 */
function assertWorkspaceRequest(input: unknown): WorkspaceRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AssetsStoreError('BAD_REQUEST', '缺少空间上下文。')
  }
  const { workspaceId, spaceEpoch } = input as { workspaceId?: unknown; spaceEpoch?: unknown }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new AssetsStoreError('BAD_REQUEST', '空间标识非法。')
  }
  if (typeof spaceEpoch !== 'string' || spaceEpoch === '') {
    throw new AssetsStoreError('BAD_REQUEST', '空间代际非法。')
  }
  return { workspaceId, spaceEpoch }
}

/**
 * 读取一个正整数分页参数。
 *
 * 刻意**不做** `Number(value)` 强转：那会把 `true` / `'2'` / `[]` 静默变成数字
 * （与 `validation.ts` 的 `assertPositiveId` 属同一类隐式转换问题）。只接受 number 类型的
 * safe integer，其余一律 BAD_REQUEST。
 */
function readPositiveInt(value: unknown, fallback: number, message: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new AssetsStoreError('BAD_REQUEST', message)
  }
  return value
}

/** 校验分页参数（默认 1 / 50，每页上限 200）。 */
function readPaging(input: unknown): { page: number; pageSize: number } {
  const raw = (input ?? {}) as { page?: unknown; pageSize?: unknown }
  const page = readPositiveInt(raw.page, 1, '页码非法。')
  const pageSize = readPositiveInt(
    raw.pageSize,
    ASSETS_PAGE_DEFAULT,
    `每页条数需在 ${ASSETS_PAGE_MIN}–${ASSETS_PAGE_MAX} 之间。`
  )
  if (pageSize < ASSETS_PAGE_MIN || pageSize > ASSETS_PAGE_MAX) {
    throw new AssetsStoreError('BAD_REQUEST', `每页条数需在 ${ASSETS_PAGE_MIN}–${ASSETS_PAGE_MAX} 之间。`)
  }
  return { page, pageSize }
}

/** 渲染层路径边界校验：把 `assertRendererPath` 的拒绝统一映射为 `PATH_REJECTED`。 */
function assertSafePath(input: unknown, mode: 'read' | 'write'): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new AssetsStoreError('BAD_REQUEST', '路径必须是非空字符串。')
  }
  try {
    return assertRendererFilePath(input, mode)
  } catch (error) {
    throw new AssetsStoreError('PATH_REJECTED', error instanceof Error ? error.message : '路径被拒绝。')
  }
}

/**
 * 从请求中解析条件写对象（expectedRevision 必填，expectedCurrentVersionId 三态）。
 *
 * 三态必须与 `fileService.parseCondition` 对齐（R6）：
 * - 缺省（key 不存在）→ 不传 `expectedCurrentVersionId`，service 视为「不校验当前版本指针」；
 * - 显式 `null` → 传 `expectedCurrentVersionId: null`，语义为「当前应当没有任何版本」
 *   （首次导入 / 空资产回滚等场景），**绝不**静默丢弃——否则与 asset core 的 WriteCondition 契约失真；
 * - 正整数 → 传该 id。
 * 非法类型（字符串 / 数组 / 负数等）由 assertPositiveId 抛 BAD_REQUEST。
 */
export function parseWriteCondition(request: Record<string, unknown>): Record<string, unknown> {
  if (!('expectedRevision' in request)) throw new AssetsStoreError('BAD_REQUEST', '缺少 expectedRevision。')
  const expectedRevision = assertPositiveId(request.expectedRevision, 'expectedRevision')
  const condition: Record<string, unknown> = { expectedRevision }
  if ('expectedCurrentVersionId' in request) {
    const raw = request.expectedCurrentVersionId
    if (raw === null) {
      condition.expectedCurrentVersionId = null
    } else {
      condition.expectedCurrentVersionId = assertPositiveId(raw, 'expectedCurrentVersionId')
    }
  }
  return condition
}

/** 完整资产域固定通道（`assets:*`）。 */
export function registerAssetsHandlers(): void {
  ipcMain.handle(ASSETS_CHANNELS.scanFolder,async (_event,request:unknown)=>{
    try{
      const scope=assertWorkspaceRequest(request),r=request as Record<string,unknown>
      if(Object.keys(r).some(k=>!['workspaceId','spaceEpoch','folderPath','category','tagNames'].includes(k)))throw new AssetsStoreError('BAD_REQUEST','含未知字段。')
      if(typeof r.folderPath!=='string'||!pickedPaths.has(resolve(r.folderPath)))throw new AssetsStoreError('PATH_REJECTED','请在原生对话框选择文件夹。')
      const path=assertRendererPath(r.folderPath,'read'),{workspaceId:_w,spaceEpoch:_e,folderPath:_p,...input}=r
      return {ok:true,queue:await assetsStoreManager.run(scope,async ctx=>scanFolder(ctx,path,input,p=>{assertRendererPath(p,'read')}))}
    }catch(error){return failure(error)}
  })
  ipcMain.handle(ASSETS_CHANNELS.nextFolderFile,async (_event,request:unknown)=>{
    try{const scope=assertWorkspaceRequest(request),{workspaceId:_w,spaceEpoch:_e,...input}=request as Record<string,unknown>;return {ok:true,queue:await assetsStoreManager.run(scope,ctx=>nextFolderFile(ctx,input))}}catch(error){return failure(error)}
  })
  ipcMain.handle(ASSETS_CHANNELS.cancelFolder,async (_event,request:unknown)=>{
    try{const scope=assertWorkspaceRequest(request),ctx=await assetsStoreManager.getForRequest(scope),{workspaceId:_w,spaceEpoch:_e,...input}=request as Record<string,unknown>;return {ok:true,...cancelFolder(ctx,input)}}catch(error){return failure(error)}
  })
  const exchangeServices = {
    adaptPromptImport:(ctx:AssetsContext,query:unknown)=>{ctx.assertCurrent();return {adaptation:adaptPromptImport(query)}},
    previewBatch:(ctx:AssetsContext,query:unknown)=>({preview:previewBatch(ctx,query)}),
    commitBatch:(ctx:AssetsContext,query:unknown)=>({result:commitBatch(ctx,query)}),
    exportAssets: (ctx: AssetsContext, query: unknown) => ({ result: exportAssets(ctx,query) }),
    previewImport: (ctx: AssetsContext, query: unknown) => ({ preview: previewImport(ctx,query) }),
    importJson: (ctx: AssetsContext, query: unknown) => ({ result: commitImport(ctx,query) })
  }
  ipcMain.handle(ASSETS_CHANNELS.readExchangeFile,async (_event,request:unknown)=>{
    try {
      const scope=assertWorkspaceRequest(request),r=request as Record<string,unknown>
      if(Object.keys(r).some(k=>!['workspaceId','spaceEpoch','sourcePath'].includes(k)))throw new AssetsStoreError('BAD_REQUEST','含未知字段。')
      let path:string
      try {path=assertRendererFilePath(r.sourcePath,'read')}catch{throw new AssetsStoreError('PATH_REJECTED','请通过文件选择器重新选择JSON。')}
      return {ok:true,...await assetsStoreManager.run(scope,async ctx=>readExchangeFile(ctx,path))}
    }catch(error){return failure(error)}
  })
  ipcMain.handle(ASSETS_CHANNELS.saveExchange,async (_event,request:unknown)=>{
    let lease:AssetSaveLease|undefined
    try {
      const scope=assertWorkspaceRequest(request),r=request as Record<string,unknown>
      if(Object.keys(r).some(k=>!['workspaceId','spaceEpoch','destinationPath','query','ids','format','ai'].includes(k)))throw new AssetsStoreError('BAD_REQUEST','含未知字段。')
      try{lease=claimAssetSavePath(r.destinationPath)}catch{throw new AssetsStoreError('PATH_REJECTED','请通过保存对话框选择新路径。')}
      const {workspaceId:_w,spaceEpoch:_e,destinationPath:_p,...input}=r,claimed=lease
      const result=await assetsStoreManager.run(scope,async ctx=>{const out=saveExchange(ctx,input,claimed.path);claimed.commit();return out})
      return {ok:true,...result}
    }catch(error){return failure(error)}finally{lease?.release()}
  })
  for (const method of Object.keys(exchangeServices) as (keyof typeof exchangeServices)[]) {
    ipcMain.handle(ASSETS_CHANNELS[method],async (_event,request: unknown) => {
      try {
        const scope=assertWorkspaceRequest(request)
        const ctx=await assetsStoreManager.getForRequest(scope)
        const { workspaceId: _workspace, spaceEpoch: _epoch, ...query }=request as Record<string,unknown>
        return { ok:true,...exchangeServices[method](ctx,query) }
      } catch (error) { return failure(error) }
    })
  }
  const referenceServices = {
    setFavorite, recordUsage,
    listSavedFilters:(ctx:AssetsContext,query:unknown)=>({filters:listSavedFilters(ctx,query)}),
    createSavedFilter:(ctx:AssetsContext,query:unknown)=>({filter:createSavedFilter(ctx,query)}),
    updateSavedFilter:(ctx:AssetsContext,query:unknown)=>({filter:updateSavedFilter(ctx,query)}),
    deleteSavedFilter,
    references: (ctx: AssetsContext, query: unknown) => ({ references: getReferences(ctx, query) }),
    addReference,
    removeReference,
    referenceGraph: (ctx: AssetsContext, query: unknown) => ({ graph: getReferenceGraph(ctx, query) })
  }
  for (const method of Object.keys(referenceServices) as (keyof typeof referenceServices)[]) {
    ipcMain.handle(ASSETS_CHANNELS[method], async (_event, request: unknown) => {
      try {
        const scope = assertWorkspaceRequest(request)
        const ctx = await assetsStoreManager.getForRequest(scope)
        const { workspaceId: _workspace, spaceEpoch: _epoch, ...query } = request as Record<string, unknown>
        return { ok: true, ...referenceServices[method](ctx, query) }
      } catch (error) { return failure(error) }
    })
  }
  ipcMain.handle(ASSETS_CHANNELS.context, async () => {
    try {
      return { ok: true, context: assetsStoreManager.context() }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.list, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      readPaging(request)
      const ctx = await assetsStoreManager.getForRequest(scope)
      const { workspaceId: _workspace, spaceEpoch: _epoch, ...query } = request as Record<string, unknown>
      return { ok: true, page: listAssets(ctx, query) }
    } catch (error) {
      return failure(error)
    }
  })

  // Synchronous services retain transaction/scope guards; every fixed channel catches failures.
  const register = (channel: string, operation: (ctx: AssetsContext, req: Record<string, unknown>) => object) => {
    ipcMain.handle(channel, async (_event, request: unknown) => {
      try {
        const scope = assertWorkspaceRequest(request)
        const ctx = await assetsStoreManager.getForRequest(scope)
        return { ok: true, ...operation(ctx, request as Record<string, unknown>) }
      } catch (error) { return failure(error) }
    })
  }
  register(ASSETS_CHANNELS.get, (ctx, r) => ({ asset: getAsset(ctx, r.assetId as number) }))
  register(ASSETS_CHANNELS.create, (ctx, r) => ({ asset: createAsset(ctx, r.input) }))
  register(ASSETS_CHANNELS.update, (ctx, r) => ({ asset: updateAsset(ctx, r.assetId as number, parseWriteCondition(r), r.patch) }))
  register(ASSETS_CHANNELS.archive, (ctx, r) => archiveAsset(ctx, r.assetId, r.expectedRevision))
  register(ASSETS_CHANNELS.restore, (ctx, r) => restoreAsset(ctx, r.assetId, r.expectedRevision))
  register(ASSETS_CHANNELS.deletePreview, (ctx, r) => ({ impact: deletePreview(ctx, r.assetId) }))
  register(ASSETS_CHANNELS.delete, (ctx, r) => deleteAsset(ctx, r.assetId, r.expectedRevision, r.confirm))
  register(ASSETS_CHANNELS.listCategories, (ctx, r) => ({ categories: listCategories(ctx, r.archived as ArchiveScope | undefined) }))
  register(ASSETS_CHANNELS.createCategory, (ctx, r) => ({ category: createCategory(ctx, r.input) }))
  register(ASSETS_CHANNELS.updateCategory, (ctx, r) => ({ category: updateCategory(ctx, r.code as string, r.expectedRevision as number, r.patch) }))
  register(ASSETS_CHANNELS.categoryImpact, (ctx, r) => ({ impact: categoryImpact(ctx, r.code as string) }))
  register(ASSETS_CHANNELS.deleteCategory, (ctx, r) => {
    if (r.confirm !== true) throw new AssetsStoreError('BAD_REQUEST', '删除分类需要明确确认。')
    return { deletedCode: removeCategory(ctx, r.code as string, r.expectedRevision as number) }
  })
  register(ASSETS_CHANNELS.listTags, ctx => ({ tags: listTags(ctx) }))
  register(ASSETS_CHANNELS.createTag, (ctx, r) => createTag(ctx, r.name, r.color))
  register(ASSETS_CHANNELS.addTags, (ctx, r) => ({ asset: addTags(ctx, r.assetId, r.expectedRevision, r.tags) }))
  register(ASSETS_CHANNELS.removeTags, (ctx, r) => ({ asset: removeTags(ctx, r.assetId, r.expectedRevision, r.tagIds) }))
  register(ASSETS_CHANNELS.tagImpact, (ctx, r) => ({ impact: tagImpact(ctx, r.tagId, r.targetName) }))
  register(ASSETS_CHANNELS.renameTag, (ctx, r) => ({ tag: renameTag(ctx, r.tagId, r.expectedRevision, r.name) }))
  register(ASSETS_CHANNELS.mergeTags, (ctx, r) => ({ target: mergeTags(ctx, r.sourceId, r.targetId, r.expectedSourceRevision, r.expectedTargetRevision, r.confirm) }))
  register(ASSETS_CHANNELS.deleteTag, (ctx, r) => deleteTag(ctx, r.tagId, r.expectedRevision, r.confirm))

  ipcMain.handle(ASSETS_CHANNELS.importFile, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      // R4：导入源用更严格的「文件」通道校验——必须是用户在文件对话框中显式选中的精确文件。
      const sourcePath = assertSafePath(req.sourcePath, 'read')
      const asset = await assetsStoreManager.run(scope, async (ctx) =>
        importFile(ctx, assetId, parseWriteCondition(req), sourcePath, typeof req.changelog === 'string' ? req.changelog : undefined)
      )
      return { ok: true, asset }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.saveFile, async (_event, request: unknown) => {
    let lease: AssetSaveLease | undefined
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      const versionId = req.versionId === undefined || req.versionId === null ? undefined : assertPositiveId(req.versionId, 'versionId')
      // 控制平面 / 托管目录已在 assertRendererPath 内先行拒绝；dialog:save 注册的一次性精确授权在此放行。
      if (typeof req.destinationPath !== 'string' || req.destinationPath.trim() === '') {
        throw new AssetsStoreError('BAD_REQUEST', '路径必须是非空字符串。')
      }
      try { lease = claimAssetSavePath(req.destinationPath) } catch (error) {
        throw new AssetsStoreError('PATH_REJECTED', error instanceof Error ? error.message : '路径被拒绝。')
      }
      const claimed = lease
      const result = await assetsStoreManager.run(scope, async (ctx) => {
        const saved = saveFile(ctx, assetId, versionId, claimed.path)
        claimed.commit()
        return saved
      })
      return { ok: true, ...result }
    } catch (error) {
      return failure(error)
    } finally {
      lease?.release()
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.listVersions, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      const ctx = await assetsStoreManager.getForRequest(scope)
      const page = listVersions(ctx, assetId, req.page, req.pageSize)
      return { ok: true, page }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.getVersion, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      const versionId = assertPositiveId(req.versionId, 'versionId')
      const ctx = await assetsStoreManager.getForRequest(scope)
      const { version } = getVersion(ctx, assetId, versionId)
      return { ok: true, version }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.diffVersions, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      const fromVersionId = assertPositiveId(req.fromVersionId, 'fromVersionId')
      const toVersionId = assertPositiveId(req.toVersionId, 'toVersionId')
      const ctx = await assetsStoreManager.getForRequest(scope)
      const { diff } = diffVersions(ctx, assetId, fromVersionId, toVersionId)
      return { ok: true, diff }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.rollbackVersion, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      const versionId = assertPositiveId(req.versionId, 'versionId')
      const ctx = await assetsStoreManager.getForRequest(scope)
      const result = rollbackVersion(ctx, assetId, parseWriteCondition(req), versionId)
      return { ok: true, ...result }
    } catch (error) {
      return failure(error)
    }
  })
}
