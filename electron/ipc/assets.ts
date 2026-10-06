/**
 * 资产库 IPC 域（`assets:*`）。
 *
 * I0-05 只建立**最小真实通路**：`assets:context`（取当前可信空间作用域）与
 * `assets:list`（对真实库做一次计数查询，返回真实空态）。完整的 §3.3 方法在 I1-08 接线。
 *
 * 纪律（与其它 IPC 域一致）：
 * - 返回值统一判别联合 `{ ok: true, ... } | { ok: false, code, message }`，**不向渲染层抛异常**；
 * - 业务错误回传 `AssetsStoreError.code`；未知异常记主进程日志并回有意义的提示，
 *   不泄漏 SQL / 堆栈 / 凭据；
 * - 渲染层传入的路径参数若将来出现，一律在 try 内部过 `assertRendererPath`（本域当前不接收路径）。
 */
import { ipcMain } from 'electron'
import {
  ASSETS_CHANNELS,
  ASSETS_PAGE_DEFAULT,
  ASSETS_PAGE_MAX,
  ASSETS_PAGE_MIN
} from '../../shared/assetsContracts'
import type { AssetPage, AssetsErrorCode, WorkspaceRequest } from '../../shared/assetsContracts'
import { assetsStoreManager } from '../assets/store'
import { AssetsStoreError } from '../assets/types'
import { assertPositiveId } from '../assets/validation'
import {
  importFile,
  saveFile,
  listVersions,
  getVersion,
  diffVersions,
  rollbackVersion
} from '../assets/fileService'
import { assertRendererPath } from './rendererPathGuards'
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
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    }
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
  if (typeof input !== 'object' || input === null) {
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
    return assertRendererPath(input, mode)
  } catch (error) {
    throw new AssetsStoreError('PATH_REJECTED', error instanceof Error ? error.message : '路径被拒绝。')
  }
}

/** 从请求中解析条件写对象（expectedRevision 必填，expectedCurrentVersionId 可选）。 */
function parseWriteCondition(request: Record<string, unknown>): Record<string, unknown> {
  if (!('expectedRevision' in request)) throw new AssetsStoreError('BAD_REQUEST', '缺少 expectedRevision。')
  const expectedRevision = assertPositiveId(request.expectedRevision, 'expectedRevision')
  const condition: Record<string, unknown> = { expectedRevision }
  if (request.expectedCurrentVersionId !== undefined && request.expectedCurrentVersionId !== null) {
    condition.expectedCurrentVersionId = assertPositiveId(request.expectedCurrentVersionId, 'expectedCurrentVersionId')
  }
  return condition
}

/** 资产库：空间上下文 / 列表 / 文件版本（`assets:*`）。 */
export function registerAssetsHandlers(): void {
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
      const { page, pageSize } = readPaging(request)
      const ctx = await assetsStoreManager.getForRequest(scope)
      // 真实查询：I1 的资产服务落地前，这里只做一次计数，返回真实空态而非假列表。
      const total = ctx.write(
        (session) =>
          session.get<{ c: number }>('SELECT COUNT(*) AS c FROM asset WHERE archived_at IS NULL')?.c ?? 0
      )
      const result: AssetPage = { items: [], total, page, pageSize }
      return { ok: true, page: result }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.importFile, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      const sourcePath = assertSafePath(req.sourcePath, 'read')
      const ctx = await assetsStoreManager.getForRequest(scope)
      const asset = importFile(ctx, assetId, parseWriteCondition(req), sourcePath, typeof req.changelog === 'string' ? req.changelog : undefined)
      return { ok: true, asset }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(ASSETS_CHANNELS.saveFile, async (_event, request: unknown) => {
    try {
      const scope = assertWorkspaceRequest(request)
      const req = (request ?? {}) as Record<string, unknown>
      const assetId = assertPositiveId(req.assetId, 'assetId')
      const versionId = req.versionId === undefined || req.versionId === null ? undefined : assertPositiveId(req.versionId, 'versionId')
      const destinationPath = assertSafePath(req.destinationPath, 'write')
      const ctx = await assetsStoreManager.getForRequest(scope)
      const result = saveFile(ctx, assetId, versionId, destinationPath)
      return { ok: true, ...result }
    } catch (error) {
      return failure(error)
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
