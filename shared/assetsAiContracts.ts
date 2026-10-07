import type { AssetDetail } from './assetsContracts'
import type { TemplateValues } from './assetsContracts'
import type { AssetsResult, WorkspaceRequest } from './assetsContracts'

export type AiAssistMode = 'polish' | 'restructure'
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
/** 仅由可信模型适配器保存已完成结果；不含凭据或任意Provider配置。 */
export interface AiDraftInput {
  assetId: number
  sourceVersionId: number
  sourceRevision: number
  mode: AiAssistMode
  content: string
  model: string
  promptAssetId: number | null
  promptSnapshot: string
  usage: AiUsage
}
export interface AiDraft extends AiDraftInput {
  id: number
  status: 'pending'
  createdAt: string
}
export type AiDraftSummary = Omit<AiDraft, 'content' | 'promptSnapshot'> & { assetName: string }
export interface AiDraftQuery { assetId?: number; page?: number; pageSize?: number }
export interface AiAdoptInput {
  expectedRevision: number
  carry?: 'version' | 'derived'
  content?: string
  name?: string
  category?: string
}
export interface AiAdoptResult { asset: AssetDetail; carry: 'version' | 'derived' }

export interface AiGenerateRequest {
  assetId: number
  mode: AiAssistMode
  sourceVersionId?: number
  promptAssetId?: number
  values?: TemplateValues
}
export interface AiTagsRequest { assetId: number; sourceVersionId?: number; max?: number }
export interface AiTagSuggestion { name: string; existingTagId: number | null }
export interface AiTagsResult {
  suggestions: AiTagSuggestion[]
  contentTruncated: boolean
  truncated: boolean
  model: string
  sourceVersionId: number
  sourceRevision: number
}

/** 显式 UI 动作的固定门面；不接受 Provider、密钥、任意路径或客户端草稿快照。 */
export interface AssetsAiApi {
  generateAiDraft(req: WorkspaceRequest & { requestId: string; confirmSend: true; input: AiGenerateRequest }): Promise<AssetsResult<{ draft: AiDraft }>>
  suggestAiTags(req: WorkspaceRequest & { requestId: string; confirmSend: true; input: AiTagsRequest }): Promise<AssetsResult<AiTagsResult>>
  cancelAiRequest(req: WorkspaceRequest & { requestId: string }): Promise<AssetsResult<{ canceled: boolean }>>
  listAiDrafts(req: WorkspaceRequest & { query?: AiDraftQuery }): Promise<AssetsResult<{ page: { items: AiDraftSummary[]; total: number; page: number; pageSize: number } }>>
  getAiDraft(req: WorkspaceRequest & { draftId: number }): Promise<AssetsResult<{ draft: AiDraft }>>
  adoptAiDraft(req: WorkspaceRequest & { draftId: number; confirm: true; input: AiAdoptInput }): Promise<AssetsResult<AiAdoptResult>>
  discardAiDraft(req: WorkspaceRequest & { draftId: number; confirm: true }): Promise<AssetsResult<{ discarded: boolean }>>
  adoptSuggestedTags(req: WorkspaceRequest & { confirm: true; input: { assetId: number; expectedRevision: number; names: string[] } }): Promise<AssetsResult<{ asset: AssetDetail }>>
}
