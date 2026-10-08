/** 主应用宿主；仅注入当前唯一writer，不自行构造store/seed/模型。 */
import type { AssetsContext } from '../types'
import type { WorkspaceRequest } from '../../../shared/assetsContracts'
import { dispatchAssetTool } from './adapter'
import { startAssetsBroker, startAssetsLoopbackBroker, type BrokerRequest } from './broker'
import { startWindowsPipeRelay, type WindowsPipeRelay } from './windowsPipeRelay'
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
  const endpoint = localEndpoint(directory)
  const brokerOptions = { currentScope: options.currentScope, dispatch: (request: BrokerRequest) => dispatchAssetTool(request, options.context), approve: options.approve }
  const broker = process.platform === 'win32'
    ? await startAssetsLoopbackBroker(brokerOptions)
    : await startAssetsBroker({ ...brokerOptions, endpoint })
  let relay: WindowsPipeRelay | undefined
  let discovery: Awaited<ReturnType<typeof publishDiscovery>> | undefined
  let closing: Promise<void> | undefined, ended = false
  const close = () => closing ??= (async () => {
    ended = true
    // Stop requests/approval before helper shutdown and the main writer drain.
    try { await broker.close() } finally {
      try { await relay?.close() } finally { await discovery?.close() }
    }
  })()
  try {
    if (process.platform === 'win32') {
      relay = await startWindowsPipeRelay({ endpoint, port: (broker as {port:number}).port })
      // No await inside closed notification: avoid circular close/closed dependencies.
      void relay.closed.then(() => { ended = true; void close().catch(() => {}) })
    }
    discovery = await publishDiscovery(options.userData, { endpoint, token: broker.token })
    // Exit may race the asynchronous publication; clean the newly published file too.
    if (ended) { await discovery.close(); throw new Error('MCP relay unavailable') }
    return { discoveryPath: discovery.path, close }
  } catch (error) { await close(); throw error }
}
