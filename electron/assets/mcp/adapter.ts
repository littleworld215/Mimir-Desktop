/** 外部14工具业务适配；接主进程现有context，不创建第二writer，不调用模型。 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolveWithinFiles } from '../paths'
import type { AssetKind, WorkspaceRequest } from '../../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext } from '../types'
import { createAsset, getAsset, updateAsset } from '../assetService'
import { listCategories } from '../categoryService'
import { listTags, addTags, removeTags } from '../tagService'
import { normalizeTagName } from '../tagNormalization'
import { searchAssets } from '../searchService'
import { addReference, getReferenceGraph } from '../referenceService'
import { listSavedFilters } from '../collectionService'
import { saveAiDraft, getAiDraft, adoptAiDraft } from '../aiDraftService'
import { assertAssetCode, assertTagName } from '../validation'
import { BrokerError, type BrokerErrorCode } from './localTransport'
import { MCP_READ_TOOLS, MCP_WRITE_TOOLS } from './broker'

export interface ExternalToolRequest {
  method: string; args: Record<string, unknown>; client: string; scope: Readonly<WorkspaceRequest>; signal: AbortSignal
}
const fields: Record<string, string[]> = {
  search_assets: ['query', 'categoryCode', 'tagCodes', 'kind', 'page', 'pageSize'],
  get_asset: ['assetCode', 'maxChars'], get_asset_version: ['assetCode', 'version', 'maxChars'],
  list_categories: [], list_tags: [], get_refgraph: ['assetCode', 'depth'], list_saved_filters: [],
  create_asset: ['name', 'content', 'categoryCode', 'kind', 'tags', 'sourceTask', 'confirm', 'requestId'],
  update_metadata: ['assetCode', 'baseVersion', 'name', 'content', 'description', 'categoryCode', 'confirm'],
  add_tags: ['assetCode', 'tags', 'confirm'], remove_tags: ['assetCode', 'tags', 'confirm'],
  add_reference: ['assetCode', 'targetCode', 'confirm'], save_ai_draft: ['assetCode', 'mode', 'content', 'confirm'],
  adopt_ai_draft: ['draftId', 'carry', 'confirm']
}
function bad(): never { throw new BrokerError('BAD_REQUEST') }
function integer(v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) bad()
  return v
}
function text(v: unknown, max = 1024 * 1024): string {
  if (typeof v !== 'string' || v.length > max || v.includes('\u0000')) bad()
  return v
}
function code(v: unknown): string { try { return assertAssetCode(v) } catch { return bad() } }
function names(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 100) bad()
  try { return [...new Map(v.map(name => { const checked = assertTagName(name); return [normalizeTagName(checked), checked] })).values()] } catch { return bad() }
}
function clamp(content: string, max: number) {
  let end = Math.min(content.length, max)
  if (end && end < content.length && /[\ud800-\udbff]/.test(content[end - 1]) && /[\udc00-\udfff]/.test(content[end])) end--
  return { content: content.slice(0, end), truncated: end < content.length }
}
const recognized = new Set<BrokerErrorCode>(['BAD_REQUEST', 'NOT_FOUND', 'VERSION_CONFLICT', 'REVISION_CONFLICT', 'SPACE_CHANGED', 'ASSET_ARCHIVED', 'BAD_CATEGORY'])

export async function dispatchAssetTool(request: ExternalToolRequest, context: (scope: WorkspaceRequest) => Promise<AssetsContext>): Promise<{ requestId: string; data: unknown }> {
  try {
    if (![...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS].includes(request.method as typeof MCP_READ_TOOLS[number])) throw new BrokerError('METHOD_NOT_FOUND')
    const args = request.args
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !fields[request.method].includes(k))) bad()
    if ((MCP_WRITE_TOOLS as readonly string[]).includes(request.method) && args.confirm !== true) throw new BrokerError('CONFIRM_REQUIRED')
    const assertSignal = () => { if (request.signal.aborted) throw new BrokerError('DISCONNECTED') }
    assertSignal()
    const base = await context(request.scope)
    const guard = () => {
      assertSignal()
      if (base.scope.workspaceId !== request.scope.workspaceId || base.scope.spaceEpoch !== request.scope.spaceEpoch) throw new BrokerError('SPACE_CHANGED')
      base.assertCurrent()
    }
    const ctx: AssetsContext = { scope: base.scope, layout: base.layout, assertCurrent: guard,
      write: operation => { guard(); return base.write(s => { guard(); const result = operation(s); guard(); return result }) }
    }
    guard()
    function asset(raw: unknown) {
      const key = code(raw)
      const id = ctx.write(s => s.get<{ id: number }>('SELECT id FROM asset WHERE code=?', key)?.id)
      if (!id) throw new BrokerError('NOT_FOUND')
      return getAsset(ctx, id)
    }
    let data: unknown
    switch (request.method) {
      case 'search_assets': {
        const page = args.page === undefined ? 1 : integer(args.page)
        const pageSize = args.pageSize === undefined ? 20 : integer(args.pageSize, 1, 100)
        const requested = args.tagCodes === undefined ? [] : names(args.tagCodes)
        const tags = listTags(ctx), tagIds = requested.map(name => tags.find(t => normalizeTagName(t.name) === normalizeTagName(name))?.id)
        // 即使缺标签，也先校验完整查询；缺标签是明确空集，不扩大条件。
        const result = searchAssets(ctx, { page, pageSize, q: args.query === undefined ? '' : text(args.query),
          ...(args.categoryCode === undefined ? {} : { category: code(args.categoryCode) }),
          ...(args.kind === undefined ? {} : { kind: args.kind }), tagIds: tagIds.filter((id): id is number => id !== undefined), tagMode: 'and', sort: 'updated' })
        const missing = tagIds.includes(undefined)
        data = { items: missing ? [] : result.items.map(a => ({ id: a.id, code: a.code, name: a.name, kind: a.kind, category: a.category,
          tags: a.tags.map(t => t.name), summary: clamp(a.description, 1000).content, currentVersion: a.currentVersion, updatedAt: a.updatedAt })),
          page, pageSize, total: missing ? 0 : result.total, hasMore: !missing && page * pageSize < result.total }
        break
      }
      case 'get_asset': case 'get_asset_version': {
        const a = asset(args.assetCode), max = args.maxChars === undefined ? 32000 : integer(args.maxChars, 1, 32000)
        const number = request.method === 'get_asset_version' ? integer(args.version) : a.currentVersion ?? 0
        const v = number === 0 ? undefined : ctx.write(s => s.get<{ version: number; content: string; file_name: string | null; file_path: string | null }>('SELECT version,content,file_name,file_path FROM asset_version WHERE asset_id=? AND version=?', a.id, number))
        if (number !== 0 && !v) throw new BrokerError('NOT_FOUND')
        let fileAvailable = false
        if (a.storageType === 'file' && v?.file_path) {
          try { fileAvailable = existsSync(resolveWithinFiles(ctx.layout, v.file_path)) } catch { /* 非法路径视为不可用，绝不向客户端暴露路径。 */ }
        }
        data = { assetCode: a.code, version: number, content: clamp(a.storageType === 'inline_text' ? v?.content ?? '' : '', max),
          storageType: a.storageType, fileName: v?.file_name ?? null,
          fileAvailable,
          ...(request.method === 'get_asset' ? { name: a.name, category: a.category, kind: a.kind, sourceTask: clamp(a.sourceTask, 2000).content, tags: a.tags.map(t => t.name), externalUrl: a.externalUrl } : {}) }
        break
      }
      case 'list_categories': data = listCategories(ctx); break
      case 'list_tags': data = listTags(ctx).map(t => ({ name: t.name, usageCount: ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset_tag WHERE tag_id=?', t.id)!.n) })); break
      case 'list_saved_filters': data = listSavedFilters(ctx).map(f => ({ id: f.id, name: f.name, query_json: JSON.stringify(f.query), created_at: f.createdAt, updated_at: f.updatedAt })); break
      case 'get_refgraph': {
        const a = asset(args.assetCode), depth = args.depth === undefined ? 1 : integer(args.depth, 1, 3)
        const graph = getReferenceGraph(ctx, { assetId: a.id, depth }), codes = new Map(graph.nodes.map(n => [n.id, n.code]))
        data = { depth, truncated: graph.truncated, edges: graph.edges.map(e => ({ fromCode: codes.get(e.sourceAssetId), toCode: codes.get(e.targetAssetId) })) }
        break
      }
      case 'create_asset': {
        if (args.requestId !== undefined) text(args.requestId, 200)
        const a = createAsset(ctx, { name: text(args.name, 200), content: text(args.content), category: code(args.categoryCode), storageType: 'inline_text',
          ...(args.kind === undefined ? {} : { kind: args.kind as AssetKind }),
          ...(args.sourceTask === undefined ? {} : { sourceTask: text(args.sourceTask) }),
          ...(args.tags === undefined ? {} : { tagNames: names(args.tags) }), source: { source: 'mcp', externalClient: text(request.client, 80) } })
        data = { assetCode: a.code, version: a.currentVersion }; break
      }
      case 'update_metadata': {
        const a = asset(args.assetCode)
        if (integer(args.baseVersion, 0) !== (a.currentVersion ?? 0)) throw new BrokerError('VERSION_CONFLICT')
        const patch = { ...(args.name === undefined ? {} : { name: text(args.name, 200) }),
          ...(args.content === undefined ? {} : { content: text(args.content) }),
          ...(args.description === undefined ? {} : { description: text(args.description) }),
          ...(args.categoryCode === undefined ? {} : { category: code(args.categoryCode) }) }
        const updated = updateAsset(ctx, a.id, { expectedRevision: a.revision, expectedCurrentVersionId: a.currentVersionId }, patch)
        data = { assetCode: updated.code, version: updated.currentVersion }; break
      }
      case 'add_tags': case 'remove_tags': {
        const a = asset(args.assetCode), wanted = names(args.tags)
        if (request.method === 'add_tags') addTags(ctx, a.id, a.revision, wanted.map(name => ({ name })))
        else removeTags(ctx, a.id, a.revision, a.tags.filter(t => wanted.some(n => normalizeTagName(n) === normalizeTagName(t.name))).map(t => t.id))
        data = { assetCode: a.code, tags: getAsset(ctx, a.id).tags.map(t => t.name) }; break
      }
      case 'add_reference': {
        const a = asset(args.assetCode), target = asset(args.targetCode)
        addReference(ctx, { sourceAssetId: a.id, targetAssetId: target.id, expectedRevision: a.revision })
        data = { assetCode: a.code, targetCode: target.code }; break
      }
      case 'save_ai_draft': {
        const a = asset(args.assetCode)
        const d = saveAiDraft(ctx, { assetId: a.id, sourceVersionId: a.currentVersionId, sourceRevision: a.revision, mode: args.mode,
          content: text(args.content), model: 'external-client', promptAssetId: null,
          promptSnapshot: '外部客户端提供的结果；本应用未调用模型。来源版本快照在保存草稿时捕获，外部模型和实际Prompt未知。',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
        data = { draftId: d.id, assetCode: a.code }; break
      }
      case 'adopt_ai_draft': {
        const id = integer(args.draftId), d = getAiDraft(ctx, id), a = getAsset(ctx, d.assetId)
        const result = adoptAiDraft(ctx, id, { expectedRevision: a.revision, ...(args.carry === undefined ? {} : { carry: args.carry }) })
        data = { assetCode: result.asset.code, version: result.asset.currentVersion, ...(result.asset.id === a.id ? {} : { derivedFrom: a.code }) }; break
      }
    }
    guard()
    return { requestId: randomUUID(), data }
  } catch (error) {
    if (error instanceof BrokerError) throw error
    if (error instanceof AssetsStoreError && recognized.has(error.code as BrokerErrorCode)) throw new BrokerError(error.code as BrokerErrorCode)
    if (error instanceof AssetsStoreError && ['BAD_KIND', 'BAD_TEMPLATE_CONFIG', 'TAG_CONFLICT'].includes(error.code)) throw new BrokerError('BAD_REQUEST')
    throw new BrokerError('INTERNAL_ERROR')
  }
}
