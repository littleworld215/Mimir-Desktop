/** 模型动作与写事务分离：捕获快照→可取消模型请求→空间复验→独立草稿。 */
import type { AiDraft, AiTagsResult } from '../../shared/assetsAiContracts'
import type { TemplateValues } from '../../shared/assetsContracts'
import { buildConfiguredFinalPrompt } from '../../shared/assetsTemplate'
import { configuredAssetsAiProvider, type AssetsAiProvider, type AssetsAiResponse } from './aiProvider'
import { POLISH_PROMPT, RESTRUCTURE_PROMPT, TAG_SUGGEST_PROMPT } from './aiPrompts'
import { saveAiDraft } from './aiDraftService'
import { selectAsset } from './assetRepository'
import { addTags } from './tagService'
import { assertContentBytes, assertTagName } from './validation'
import { buildTagSuggestPrompt, parseTagSuggestions, truncateForSuggest } from './tagSuggestions'
import { AssetsStoreError, type AssetsContext } from './types'
import { recordUnreportedAssetsAiFailure, runAssetsAiTask } from './aiTasks'
export { stopAllAssetsAiTasksAndWait } from './aiTasks'

/** 主进程持有的实际寿命，不能通过渲染层DTO指定。 */
export interface AssetsAiLifetime { completion?: Promise<unknown> }
export interface AssetsAiOptions { provider?: AssetsAiProvider | null; signal?: AbortSignal; timeoutMs?: number; lifetime?: AssetsAiLifetime }
function bad(message = 'AI 参数非法。'): never { throw new AssetsStoreError('BAD_REQUEST', message) }
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) bad()
  return value as Record<string, unknown>
}
function id(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) bad(); return value }
function values(input: unknown): TemplateValues {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad()
  const v = object(input, Object.keys(input as object)), result: TemplateValues = Object.create(null)
  if (Object.keys(v).length > 100) bad()
  for (const [key, value] of Object.entries(v)) {
    if (!key || key.length > 64 || /[{}:]/.test(key)) bad()
    if (typeof value === 'string' && !value.includes('\u0000')) result[key] = value
    else if (Array.isArray(value) && value.length <= 100 && Array.from(value).every(item => typeof item === 'string' && !item.includes('\u0000'))) result[key] = [...value]
    else bad()
    // 保留变量不从用户填值取值；默认/带空格模板仍沿用旧追加规则。
    if (key === '原文') delete result[key]
  }
  return result
}
function snapshot(ctx: AssetsContext, request: Record<string, unknown>) {
  const assetId = id(request.assetId), requestedVersion = request.sourceVersionId === undefined ? undefined : id(request.sourceVersionId)
  return ctx.write(s => {
    const row = selectAsset(s, assetId)
    if (!row) throw new AssetsStoreError('NOT_FOUND', '来源资产不存在。')
    if (row.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
    if (row.storage_type !== 'inline_text') bad('AI 仅支持文本资产。')
    const sourceVersionId = requestedVersion ?? row.current_version_id
    const version = s.get<{ content: string }>('SELECT content FROM asset_version WHERE id=? AND asset_id=?', sourceVersionId, assetId)
    if (!version || !version.content.trim()) bad('来源版本非法或正文为空。')
    return { assetId, sourceVersionId: sourceVersionId!, sourceRevision: row.revision, content: version.content }
  })
}
function provider(options: AssetsAiOptions): AssetsAiProvider {
  if (options.signal?.aborted) throw new AssetsStoreError('AI_ABORTED', '已取消模型请求。')
  let p: AssetsAiProvider | null
  try { p = options.provider === undefined ? configuredAssetsAiProvider() : options.provider }
  catch { throw new AssetsStoreError('AI_FAILED', '模型请求失败，请检查模型设置或稍后重试。') }
  if (!p) throw new AssetsStoreError('AI_NO_MODEL', '请在设置中配置并选择可用模型。')
  return p
}
/** 公开deadline及时反馈；原模型及同步发布仍受监督到实际结束。 */
async function complete<T>(ctx: AssetsContext, p: AssetsAiProvider, prompt: string, options: AssetsAiOptions, publish: (response: AssetsAiResponse) => T): Promise<T> {
  const timeout = options.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) bad('请求超时配置必须为1–120000毫秒。')
  const controller = new AbortController()
  let timedOut = false
  const onExternal = () => controller.abort()
  options.signal?.addEventListener('abort', onExternal, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeout)
  let onAbort!: () => void
  let published = false, publicCanceled = false
  let actualFailure: AssetsStoreError | undefined
  const rememberUnreported = () => { if (publicCanceled && actualFailure) recordUnreportedAssetsAiFailure() }
  const normalize = (error: unknown) => error instanceof AssetsStoreError ? error
    : new AssetsStoreError('AI_FAILED', '模型请求失败，请检查模型设置或稍后重试。')
  const isCancellation = (error: unknown) => error instanceof AssetsStoreError && (error.code === 'AI_ABORTED' || error.code === 'AI_TIMEOUT')
    || error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  const cancellation = () => new AssetsStoreError(timedOut ? 'AI_TIMEOUT' : 'AI_ABORTED', timedOut ? '模型请求超时，请稍后重试。' : '已取消模型请求。')
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { if (!published) reject(cancellation()) }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
    const actual = runAssetsAiTask(ctx, controller, async signal => {
      try {
        if (signal.aborted) throw cancellation()
        ctx.assertCurrent()
        const response = await p.complete(prompt, signal)
        if (signal.aborted) throw cancellation()
        ctx.assertCurrent()
        // 发布不离开租约；检查与同步事务之间不能让控制任务插入。
        const value = publish(response)
        // 业务同步发布成功即结果确定；不能在Promise收尾间隙伪装为零写取消。
        published = true
        return value
      } catch (error) {
        const safe = normalize(error)
        if (!isCancellation(error)) { actualFailure = safe; rememberUnreported() }
        throw safe
      }
    })
    if (options.lifetime) options.lifetime.completion = actual
    const result = await Promise.race([aborted, actual])
    if (controller.signal.aborted) onAbort()
    return result
  } catch (error) {
    if (error instanceof AssetsStoreError && (error.code === 'AI_ABORTED' || error.code === 'AI_TIMEOUT')) {
      publicCanceled = true
      rememberUnreported()
    }
    if (error instanceof AssetsStoreError) throw error
    // Provider异常可能包含请求正文/Authorization；不向IPC/UI/日志转发上游原始信息。
    throw new AssetsStoreError('AI_FAILED', '模型请求失败，请检查模型设置或稍后重试。')
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onExternal); controller.signal.removeEventListener('abort', onAbort)
  }
}

export async function generateAiDraft(ctx: AssetsContext, input: unknown, options: AssetsAiOptions = {}): Promise<AiDraft> {
  const request = object(input, ['assetId', 'mode', 'sourceVersionId', 'promptAssetId', 'values'])
  if (request.mode !== 'polish' && request.mode !== 'restructure') bad()
  const supplied = values(request.values), source = snapshot(ctx, request)
  const promptAssetId = request.promptAssetId === undefined ? null : id(request.promptAssetId)
  const template = promptAssetId === null ? { content: request.mode === 'polish' ? POLISH_PROMPT : RESTRUCTURE_PROMPT, config: undefined } : ctx.write(s => {
    const row = selectAsset(s, promptAssetId)
    if (!row || row.kind !== 'prompt' || row.storage_type !== 'inline_text' || row.archived_at !== null) bad('请选择未归档的文本Prompt资产。')
    const version = s.get<{ content: string }>('SELECT content FROM asset_version WHERE id=? AND asset_id=?', row.current_version_id, row.id)
    if (!version || !version.content.trim()) bad('Prompt为空。')
    return { content: version.content, config: JSON.parse(row.template_config) as unknown }
  })
  const prompt = buildConfiguredFinalPrompt(template.content, supplied, source.content, template.config)
  // JSON转义后的快照预留4KiB给模型、时间、safe整数标识与usage，调用前拒绝不可持久化请求。
  if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > 60 * 1024) bad('最终Prompt超过60KiB快照预算，请缩小原文或模板。')
  const p = provider(options)
  return complete(ctx, p, prompt, options, response => {
    if (typeof response?.content !== 'string' || !response.content.trim()) throw new AssetsStoreError('AI_EMPTY_RESULT', '模型未返回可用正文。')
    return saveAiDraft(ctx, { assetId: source.assetId, sourceVersionId: source.sourceVersionId, sourceRevision: source.sourceRevision,
      mode: request.mode as 'polish' | 'restructure', content: response.content, model: p.model, promptAssetId, promptSnapshot: prompt, usage: response.usage })
  })
}

export async function suggestAiTags(ctx: AssetsContext, input: unknown, options: AssetsAiOptions = {}): Promise<AiTagsResult> {
  const request = object(input, ['assetId', 'sourceVersionId', 'max']), source = snapshot(ctx, request)
  const max = request.max === undefined ? 6 : id(request.max)
  if (max > 8) bad('标签建议最多8项。')
  const existing = ctx.write(s => s.all<{ id: number; name: string }>(`SELECT t.id,t.name FROM tag t LEFT JOIN asset_tag a ON a.tag_id=t.id
    GROUP BY t.id ORDER BY count(a.asset_id) DESC,t.normalized_name,t.id LIMIT 40`))
  const text = truncateForSuggest(source.content), prompt = buildTagSuggestPrompt(text.text, existing.map(t => t.name), max, TAG_SUGGEST_PROMPT)
  const p = provider(options)
  return complete(ctx, p, prompt, options, response => {
    if (typeof response?.content !== 'string') throw new AssetsStoreError('AI_EMPTY_RESULT', '模型未返回可用标签。')
    try { assertContentBytes(response.content) } catch { bad('标签返回过大或包含非法文本。') }
    const parsed = parseTagSuggestions(response.content, existing, max)
    return { suggestions: parsed.items, contentTruncated: text.truncated, truncated: parsed.truncated, model: p.model,
      sourceVersionId: source.sourceVersionId, sourceRevision: source.sourceRevision }
  })
}

/** 当前事务按名称重新查找并复用标签，不相信模型的旧ID；保留已有标签，revision冲突零写。 */
export function adoptSuggestedTags(ctx: AssetsContext, input: unknown) {
  const request = object(input, ['assetId', 'expectedRevision', 'names']), assetId = id(request.assetId), revision = id(request.expectedRevision)
  if (!Array.isArray(request.names) || request.names.length > 8) bad('最多采纳8个建议标签。')
  const names = Array.from(request.names, name => {
    try { const valid = assertTagName(name); if (valid.length > 20) bad('建议标签最长20字。'); return { name: valid } }
    catch (error) { if (error instanceof AssetsStoreError) throw error; bad('建议标签名称非法。') }
  })
  return addTags(ctx, assetId, revision, names)
}
