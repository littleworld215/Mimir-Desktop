/** 主 Agent 与资产能力域共用的固定工具；任何副作用都在主进程执行批准与空间复验。 */
import { tool } from '../trackedTool'
import { z } from 'zod'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { WorkspaceRequest } from '../../../shared/assetsContracts'
import { assetsStoreManager, type AssetsStoreManager } from '../../assets/store'
import { getAsset, listAssets } from '../../assets/assetService'
import { getAiDraft, listAiDrafts, adoptAiDraft, discardAiDraft } from '../../assets/aiDraftService'
import { generateAiDraft, suggestAiTags, adoptSuggestedTags } from '../../assets/aiService'
import { AssetsStoreError, type AssetsContext } from '../../assets/types'
import { requireBusinessApproval, requireUserApproval, type ApprovalPrompt } from '../approval'

interface Dependencies {
  manager: Pick<AssetsStoreManager, 'context' | 'getForRequest'>
  sendApproval: (prompt: ApprovalPrompt) => Promise<boolean>
  writeApproval: (prompt: ApprovalPrompt) => Promise<boolean>
  generate: typeof generateAiDraft
  suggest: typeof suggestAiTags
}
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const values = z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()

/** 注入接缝仅供离线测试；Agent 参数不能选择 provider、SQL、路径或批准策略。 */
export function createAssetTools(overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = { manager: assetsStoreManager, sendApproval: requireUserApproval,
    writeApproval: requireBusinessApproval, generate: generateAiDraft, suggest: suggestAiTags, ...overrides }
  async function execute(config: RunnableConfig | undefined, fn: (ctx: AssetsContext, check: () => void) => Promise<object> | object) {
    try {
      const signal = config?.signal
      const checkSignal = () => { if (signal?.aborted) throw new AssetsStoreError('AI_ABORTED', '操作已取消。') }
      checkSignal()
      const bound: unknown = config?.configurable?.assetsScope
      if (bound !== undefined && (!bound || typeof bound !== 'object' || Array.isArray(bound) ||
        typeof (bound as WorkspaceRequest).workspaceId !== 'string' || typeof (bound as WorkspaceRequest).spaceEpoch !== 'string')) {
        throw new AssetsStoreError('SPACE_CHANGED', 'Agent 空间快照失效。')
      }
      const ctx = await d.manager.getForRequest(bound === undefined ? d.manager.context() : bound as WorkspaceRequest)
      const check = () => { checkSignal(); ctx.assertCurrent() }
      check()
      return JSON.stringify({ ok: true, ...await fn(ctx, check) })
    } catch (error) {
      return JSON.stringify(error instanceof AssetsStoreError
        ? { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        : { ok: false, code: 'WRITE_FAILED', message: '资产工具执行失败，请重试。' })
    }
  }
  async function approve(name: string, summary: string, check: () => void, outbound = false) {
    const allowed = await (outbound ? d.sendApproval : d.writeApproval)({ tool: name, summary,
      detail: outbound ? '将指定资产正文、选用的 Prompt 与候选标签发送到设置中的模型；结果仍待采纳。' : '仅操作当前科研空间；版本历史保留。' })
    check()
    if (!allowed) throw new AssetsStoreError('APPROVAL_DENIED', '操作未获用户批准，已取消。')
  }
  return [
    tool(async ({ keyword, ...input }, config) => execute(config, ctx => ({ page: listAssets(ctx, { ...input, q: keyword }) })), {
      name: 'asset_search', description: '检索当前科研空间的可复用资产，分页摘要，不读取文件或调用额外模型。先搜索再使用真实 assetId。',
      schema: z.object({ keyword: z.string().optional(), category: z.string().optional(), page: positive.optional(), pageSize: positive.max(200).optional() }).strict()
    }),
    tool(async ({ assetId, offset = 0, limit = 20000 }, config) => execute(config, ctx => {
      const { currentContent, ...asset } = getAsset(ctx, assetId)
      const text = currentContent ?? ''
      return { asset, content: text.slice(offset, offset + limit), contentTruncated: offset > 0 || offset + limit < text.length, totalCharacters: text.length }
    }), {
      name: 'asset_read', description: '读取当前资产详情和一段正文（默认最多20000字符）；可用 offset/limit 继续读取。外链/文件只读元信息，不读取任意路径。',
      schema: z.object({ assetId: positive, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: positive.max(20000).optional() }).strict()
    }),
    tool(async (input, config) => execute(config, async (ctx, check) => {
      await approve('asset_ai', `发送资产 #${input.assetId} 到模型并生成${input.mode === 'polish' ? '润色' : '重构'}草稿`, check, true)
      return { draft: await d.generate(ctx, input, { signal: config?.signal }) }
    }), {
      name: 'asset_ai', description: '显式发送资产到设置中的模型，生成润色/重构待采纳草稿，原文不变；必须获得外发批准。可选择 Prompt 资产和变量。拒绝后不得绕路重试。',
      schema: z.object({ assetId: positive, mode: z.enum(['polish', 'restructure']), sourceVersionId: positive.optional(), promptAssetId: positive.optional(), values }).strict()
    }),
    tool(async ({ action, draftId, assetId, page, pageSize, ...input }, config) => execute(config, async (ctx, check) => {
      if (action === 'list') return { page: listAiDrafts(ctx, { assetId, page, pageSize }) }
      if (draftId === undefined) throw new AssetsStoreError('BAD_REQUEST', '需要 draftId。')
      if (action === 'read') return { draft: getAiDraft(ctx, draftId) }
      await approve('asset_draft', `${action === 'discard' ? '删除' : '采纳'}草稿 #${draftId}`, check)
      return action === 'discard' ? discardAiDraft(ctx, draftId) : adoptAiDraft(ctx, draftId, input)
    }), {
      name: 'asset_draft', description: '列出/读取/采纳/丢弃待采纳草稿。adopt 需 expectedRevision，可选 carry=version/derived、编辑正文；polish默认追加版本，restructure默认派生。冲突保留草稿；写入与删除由批准机制控制。',
      schema: z.object({ action: z.enum(['list', 'read', 'adopt', 'discard']), draftId: positive.optional(), assetId: positive.optional(), page: positive.optional(), pageSize: positive.max(200).optional(), expectedRevision: positive.optional(), carry: z.enum(['version', 'derived']).optional(), content: z.string().optional(), name: z.string().optional(), category: z.string().optional() }).strict()
    }),
    tool(async ({ action, assetId, sourceVersionId, max, expectedRevision, names }, config) => execute(config, async (ctx, check) => {
      await approve('asset_tags', `${action === 'suggest' ? '发送正文并建议' : '采纳'}资产 #${assetId} 的标签`, check, action === 'suggest')
      return action === 'suggest'
        ? d.suggest(ctx, { assetId, sourceVersionId, max }, { signal: config?.signal })
        : { asset: adoptSuggestedTags(ctx, { assetId, expectedRevision, names }) }
    }), {
      name: 'asset_tags', description: 'suggest 外发正文获得最多8个只读标签候选（需要外发批准）；adopt 需 expectedRevision/names 并批准，重新按名称查找复用，保留原标签，不信旧候选ID。',
      schema: z.object({ action: z.enum(['suggest', 'adopt']), assetId: positive, sourceVersionId: positive.optional(), max: positive.max(8).optional(), expectedRevision: positive.optional(), names: z.array(z.string()).max(8).optional() }).strict()
    })
  ]
}

export const assetTools = createAssetTools()
