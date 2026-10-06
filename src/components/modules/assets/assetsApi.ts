/**
 * 资产库渲染层 API 门面（I0-05）。
 *
 * 职责：包装 preload 暴露的 `window.electronAPI.assets`，把 IPC 的判别联合
 * （`{ ok: true, ... } | { ok: false, code, message }`）收窄成「返回数据 / 抛 AssetsApiError」
 * 两种形态，并统一错误提示。渲染层**不**直接 import 主进程服务或数据库。
 *
 * I0-05 只接线最小通路（context / list）；其余方法在 I1-08 按 `shared/assetsContracts.ts`
 * 的 `AssetsApi` 逐条补齐。
 */
import type { AssetPage, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { ASSETS_PAGE_DEFAULT } from '../../../../shared/assetsContracts'

/** 资产库调用的统一错误类型（携带主进程回传的业务 code）。 */
export class AssetsApiError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'AssetsApiError'
  }
}

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
  const result = await bridge().context()
  if (!result.ok) throw new AssetsApiError(result.code, result.message)
  return result.context
}

/** 拉取资产列表（真实查询；I1 之前只会得到真实空态）。 */
export async function listAssets(
  context: WorkspaceRequest,
  page = 1,
  pageSize = ASSETS_PAGE_DEFAULT
): Promise<AssetPage> {
  const result = await bridge().list({ ...context, page, pageSize })
  if (!result.ok) throw new AssetsApiError(result.code, result.message)
  return result.page
}
