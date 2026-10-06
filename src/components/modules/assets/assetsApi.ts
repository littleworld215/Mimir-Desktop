/**
 * 资产库渲染层 API 门面（I1-08）。
 *
 * 职责：包装 preload 暴露的 `window.electronAPI.assets`，把 IPC 的判别联合
 * （`{ ok: true, ... } | { ok: false, code, message }`）收窄成「返回数据 / 抛 AssetsApiError」
 * 两种形态，并统一错误提示。渲染层**不**直接 import 主进程服务或数据库。
 *
 * 固定方法集来自共享合同；不暴露任意通道，冲突上下文供UI保留输入并提示刷新。
 */
import type { AssetListQuery, AssetPage, AssetsApi, AssetsResult, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { ASSETS_CHANNELS, ASSETS_PAGE_DEFAULT } from '../../../../shared/assetsContracts'

/** 资产库调用的统一错误类型（携带主进程回传的业务 code）。 */
export class AssetsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: { currentRevision?: number; currentVersionId?: number | null }
  ) {
    super(message)
    this.name = 'AssetsApiError'
  }
}

type Data<K extends keyof AssetsApi> = Omit<Extract<Awaited<ReturnType<AssetsApi[K]>>, { ok: true }>, 'ok'>
type AssetsFacade = { [K in keyof AssetsApi]: (...args: Parameters<AssetsApi[K]>) => Promise<Data<K>> }

/** Exactly the shared fixed methods; requests/results keep their per-method types. */
export const assetsApi: AssetsFacade = Object.fromEntries(
  (Object.keys(ASSETS_CHANNELS) as (keyof AssetsApi)[]).map(method => [method, async (...args: unknown[]) => {
    const api = bridge()
    const result = await (api[method] as (...params: unknown[]) => Promise<AssetsResult<object>>)(...args)
    if (!result.ok) throw new AssetsApiError(result.code, result.message, result.details)
    const { ok: _ok, ...data } = result
    return data
  }])
) as AssetsFacade

/** 取 preload 暴露的资产桥；非 Electron 环境或 preload 未加载时给出可读错误。 */
function bridge(): NonNullable<Window['electronAPI']>['assets'] {
  const api = window.electronAPI?.assets
  if (api === undefined) {
    throw new AssetsApiError('NO_BRIDGE', '资产库桥接不可用：请从 Mimir 桌面端打开本页面。')
  }
  return api
}

/** 当前科研空间的可信作用域（workspaceId + 代际）。 */
export async function getWorkspaceContext(): Promise<WorkspaceRequest> {
  const result = await assetsApi.context()
  return result.context
}

/** Existing pagination helper, with optional full query filters. */
export async function listAssets(
  context: WorkspaceRequest,
  page = 1,
  pageSize = ASSETS_PAGE_DEFAULT,
  query: Omit<AssetListQuery, 'page' | 'pageSize'> = {}
): Promise<AssetPage> {
  const result = await assetsApi.list({ ...query, ...context, page, pageSize })
  return result.page
}
