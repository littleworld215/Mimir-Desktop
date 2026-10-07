/** 读取目标现有模型设置；不创建第二套密钥存储，不主动请求网络。 */
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage } from '@langchain/core/messages'
import { getStoreValue } from '../library/store'
import type { AiUsage } from '../../shared/assetsAiContracts'

export interface AssetsAiResponse { content: string; usage: AiUsage }
export interface AssetsAiProvider {
  readonly model: string
  complete(prompt: string, signal: AbortSignal): Promise<AssetsAiResponse>
}
function tokens(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0 }

export function configuredAssetsAiProvider(): AssetsAiProvider | null {
  const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
  const models = Array.isArray(settings.models) ? settings.models.filter(m => m !== null && typeof m === 'object' && !Array.isArray(m)) as Record<string, unknown>[] : []
  const selected = models.find(m => m.id === settings.selectedModelId) ?? models[0]
  if (!selected || typeof selected.apiKey !== 'string' || !selected.apiKey.trim()) return null
  const model = typeof selected.modelId === 'string' && selected.modelId.trim() ? selected.modelId : 'deepseek-flash'
  if (model.length > 200 || model.includes('\u0000')) return null
  const chat = new ChatOpenAI({ apiKey: selected.apiKey, model, temperature: 0.3, maxRetries: 0,
    ...(typeof selected.baseUrl === 'string' && selected.baseUrl.trim() ? { configuration: { baseURL: selected.baseUrl } } : {}) })
  return {
    model,
    async complete(prompt, signal) {
      const response = await chat.invoke([new HumanMessage(prompt)], { signal })
      const content = typeof response.content === 'string' ? response.content : response.content.flatMap(block =>
        typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('')
      const usage = response.usage_metadata
      return { content, usage: { promptTokens: tokens(usage?.input_tokens), completionTokens: tokens(usage?.output_tokens), totalTokens: tokens(usage?.total_tokens) } }
    }
  }
}
