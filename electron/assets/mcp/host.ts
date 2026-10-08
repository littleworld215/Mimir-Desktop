/** 主应用宿主；仅注入当前唯一writer，不自行构造store/seed/模型。 */
import type { AssetsContext } from '../types'
import type { WorkspaceRequest } from '../../../shared/assetsContracts'
import { dispatchAssetTool } from './adapter'
import { startAssetsBroker, type BrokerRequest } from './broker'
import { localEndpoint } from './localTransport'
import { prepareDiscoveryDirectory, publishDiscovery } from './discovery'
import { getAiDraft } from '../aiDraftService'
import { getAsset } from '../assetService'

/** 采纳不能只显示草稿ID；本机不可变草稿正文与承载方式须一并显示。 */
export async function externalApprovalPreview(request: BrokerRequest, context: (scope: WorkspaceRequest) => Promise<AssetsContext>): Promise<Record<string, unknown>> {
  if (request.method !== 'adopt_ai_draft') return {}
  const ctx = await context(request.scope)
  const draft = getAiDraft(ctx, request.args.draftId), asset = getAsset(ctx, draft.assetId)
  return { assetCode: asset.code, assetName: asset.name, sourceVersionId: draft.sourceVersionId, sourceRevision: draft.sourceRevision,
    mode: draft.mode, carry: request.args.carry ?? (draft.mode === 'polish' ? 'version' : 'derived'), content: draft.content }
}

export async function startAssetsMcpHost(options: {
  userData: string
  currentScope: () => WorkspaceRequest
  context: (scope: WorkspaceRequest) => Promise<AssetsContext>
  approve: (request: BrokerRequest) => Promise<boolean>
}): Promise<{ discoveryPath: string; close(): Promise<void> }> {
  const directory = await prepareDiscoveryDirectory(options.userData)
  const broker = await startAssetsBroker({ endpoint: localEndpoint(directory), currentScope: options.currentScope,
    dispatch: request => dispatchAssetTool(request, options.context), approve: options.approve })
  try {
    const discovery = await publishDiscovery(options.userData, { endpoint: broker.endpoint, token: broker.token })
    let closing: Promise<void> | undefined
    return { discoveryPath: discovery.path, close: () => closing ??= (async () => {
      // 先中断所有客户端/确认，再排空资产writer；不允许退出清理期间新写。
      await broker.close(); await discovery.close()
    })() }
  } catch (error) { await broker.close(); throw error }
}
