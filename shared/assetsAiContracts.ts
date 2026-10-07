import type { AssetDetail } from './assetsContracts'

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
