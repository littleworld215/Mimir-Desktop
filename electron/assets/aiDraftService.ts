/** 待采纳结果与版本历史隔离；采纳的所有写入在一个受空间守卫的同步事务内。 */
import { randomUUID } from 'node:crypto'
import type { AiAdoptResult, AiDraft, AiDraftInput, AiDraftSummary, AiUsage } from '../../shared/assetsAiContracts'
import { appendVersion, detail, selectAsset, type AssetRow } from './assetRepository'
import { assertAssetCode, assertAssetName, assertContentBytes, assertSourceObject } from './validation'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new AssetsStoreError('BAD_REQUEST', 'AI 参数必须为对象且不含未知字段。')
  }
  return value as Record<string, unknown>
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new AssetsStoreError('BAD_REQUEST', 'AI 标识与版本必须是正安全整数。')
  return value
}
function validated<T>(fn: () => T): T {
  try { return fn() } catch (error) {
    if (error instanceof AssetsStoreError) throw error
    throw new AssetsStoreError('BAD_REQUEST', error instanceof Error ? error.message : 'AI 参数非法。')
  }
}
function usage(value: unknown): AiUsage {
  const v = object(value, ['promptTokens', 'completionTokens', 'totalTokens'])
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) {
    if (typeof v[key] !== 'number' || !Number.isSafeInteger(v[key]) || (v[key] as number) < 0) throw new AssetsStoreError('BAD_REQUEST', 'token 用量必须为非负安全整数。')
  }
  return v as unknown as AiUsage
}
interface DraftRow {
  id: number; asset_id: number; source_version_id: number; source_revision: number
  mode: AiDraft['mode']; content: string; model: string; prompt_asset_id: number | null
  prompt_snapshot: string; usage_json: string; status: 'pending'; created_at: string
}
function dto(row: DraftRow): AiDraft {
  return { id: row.id, assetId: row.asset_id, sourceVersionId: row.source_version_id, sourceRevision: row.source_revision,
    mode: row.mode, content: row.content, model: row.model, promptAssetId: row.prompt_asset_id,
    promptSnapshot: row.prompt_snapshot, usage: JSON.parse(row.usage_json) as AiUsage, status: row.status, createdAt: row.created_at }
}
function find(s: AssetsWriteSession, id: number): AiDraft {
  const row = s.get<DraftRow>('SELECT * FROM ai_draft WHERE id=?', id)
  if (!row) throw new AssetsStoreError('NOT_FOUND', '草稿不存在或已处理。')
  return dto(row)
}
function asset(s: AssetsWriteSession, id: number): AssetRow {
  const row = selectAsset(s, id)
  if (!row) throw new AssetsStoreError('NOT_FOUND', '来源资产不存在。')
  if (row.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
  if (row.storage_type !== 'inline_text') throw new AssetsStoreError('BAD_REQUEST', 'AI 整理仅支持文本资产。')
  return row
}
function sourceJson(d: AiDraftInput & { createdAt: string }, version: number, now: string, edited: boolean, derived: boolean): string {
  return validated(() => assertSourceObject({ aiGenerated: true, mode: d.mode,
    ...(derived ? { derivedFrom: d.assetId } : { sourceAssetId: d.assetId }), sourceVersionId: d.sourceVersionId,
    sourceVersion: version, sourceRevision: d.sourceRevision, model: d.model, promptAssetId: d.promptAssetId,
    promptContentSnapshot: d.promptSnapshot, generatedAt: d.createdAt, adoptedAt: now, edited, usage: d.usage }))
}

/** 成功模型结果唯一落库入口；不调用模型，不修改资产或版本。允许生成期间正文改变。 */
export function saveAiDraft(ctx: AssetsContext, input: unknown): AiDraft {
  const v = object(input, ['assetId', 'sourceVersionId', 'sourceRevision', 'mode', 'content', 'model', 'promptAssetId', 'promptSnapshot', 'usage'])
  const assetId = positive(v.assetId), sourceVersionId = positive(v.sourceVersionId), sourceRevision = positive(v.sourceRevision)
  if (v.mode !== 'polish' && v.mode !== 'restructure') throw new AssetsStoreError('BAD_REQUEST', 'AI 模式非法。')
  const content = validated(() => assertContentBytes(v.content)), promptSnapshot = validated(() => assertContentBytes(v.promptSnapshot))
  if (!content.trim() || !promptSnapshot.trim() || typeof v.model !== 'string' || !v.model.trim() || v.model.length > 200 || v.model.includes('\u0000')) {
    throw new AssetsStoreError('BAD_REQUEST', 'AI 结果、模型与 Prompt 不能为空或非法。')
  }
  const promptAssetId = v.promptAssetId === null ? null : positive(v.promptAssetId)
  const request: AiDraftInput = { assetId, sourceVersionId, sourceRevision, mode: v.mode, content, model: v.model, promptAssetId, promptSnapshot, usage: usage(v.usage) }
  return ctx.write(s => {
    const row = asset(s, assetId)
    const version = s.get<{ content: string; version: number }>('SELECT content,version FROM asset_version WHERE id=? AND asset_id=?', sourceVersionId, assetId)
    if (!version || !version.content.trim() || sourceRevision > row.revision) throw new AssetsStoreError('BAD_REQUEST', '来源版本或 revision 非法，或原文为空。')
    if (promptAssetId !== null) {
      const prompt = selectAsset(s, promptAssetId)
      if (!prompt || prompt.storage_type !== 'inline_text' || prompt.kind !== 'prompt' || prompt.archived_at !== null) throw new AssetsStoreError('BAD_REQUEST', 'Prompt 必须是未归档的文本模板资产。')
    }
    const now = new Date().toISOString()
    // 与交换格式的64KiB溯源预算一致；不保存将来无法采纳/导出的草稿，也不截断快照。
    sourceJson({ ...request, createdAt: now }, version.version, now, false, false)
    s.run(`INSERT INTO ai_draft(asset_id,source_version_id,source_revision,mode,content,model,prompt_asset_id,prompt_snapshot,usage_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, assetId, sourceVersionId, sourceRevision, request.mode, content, request.model, promptAssetId, promptSnapshot, JSON.stringify(request.usage), now)
    return find(s, s.get<{ id: number }>('SELECT last_insert_rowid() id')!.id)
  })
}

export function getAiDraft(ctx: AssetsContext, id: unknown): AiDraft { const key = positive(id); return ctx.write(s => find(s, key)) }

/** 全空间或单资产分页摘要；正文与Prompt快照仅在get时读取。 */
export function listAiDrafts(ctx: AssetsContext, query: unknown = {}): { items: AiDraftSummary[]; total: number; page: number; pageSize: number } {
  const q = object(query, ['assetId', 'page', 'pageSize']), page = q.page === undefined ? 1 : positive(q.page), pageSize = q.pageSize === undefined ? 50 : positive(q.pageSize)
  if (pageSize > 500 || !Number.isSafeInteger((page - 1) * pageSize)) throw new AssetsStoreError('BAD_REQUEST', '草稿分页越界。')
  const id = q.assetId === undefined ? null : positive(q.assetId)
  return ctx.write(s => {
    const where = id === null ? '' : ' WHERE d.asset_id=?', params = id === null ? [] : [id]
    const total = s.get<{ n: number }>(`SELECT count(*) n FROM ai_draft d${where}`, ...params)!.n
    const rows = s.all<Omit<DraftRow, 'content' | 'prompt_snapshot'> & { asset_name: string }>(`SELECT d.id,d.asset_id,d.source_version_id,d.source_revision,d.mode,d.model,d.prompt_asset_id,d.usage_json,d.status,d.created_at,a.name asset_name
      FROM ai_draft d JOIN asset a ON a.id=d.asset_id${where} ORDER BY d.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize)
    const items = rows.map(row => {
      const { content: _content, promptSnapshot: _prompt, ...summary } = dto({ ...row, content: '', prompt_snapshot: '' })
      return { ...summary, assetName: row.asset_name }
    })
    return { items, total, page, pageSize }
  })
}

export function discardAiDraft(ctx: AssetsContext, id: unknown): { discarded: boolean } {
  const key = positive(id)
  return ctx.write(s => ({ discarded: s.run('DELETE FROM ai_draft WHERE id=?', key).changes > 0 }))
}

/** version严格校验生成时来源；derived明确保留原文，全部写入与删草稿原子提交。 */
export function adoptAiDraft(ctx: AssetsContext, id: unknown, input: unknown): AiAdoptResult {
  const key = positive(id), v = object(input, ['expectedRevision', 'carry', 'content', 'name', 'category']), revision = positive(v.expectedRevision)
  if (v.carry !== undefined && v.carry !== 'version' && v.carry !== 'derived') throw new AssetsStoreError('BAD_REQUEST', '草稿承载方式非法。')
  const editedContent = v.content === undefined ? undefined : validated(() => assertContentBytes(v.content))
  const name = v.name === undefined ? undefined : validated(() => assertAssetName(v.name))
  const category = v.category === undefined ? undefined : validated(() => assertAssetCode(v.category))
  return ctx.write(s => {
    const d = find(s, key), row = asset(s, d.assetId), carry = v.carry ?? (d.mode === 'polish' ? 'version' : 'derived')
    if (row.revision !== revision) throw new AssetsStoreError('REVISION_CONFLICT', '来源资产已修改，请重新加载。', { currentRevision: row.revision })
    if (carry === 'version' && row.current_version_id !== d.sourceVersionId) throw new AssetsStoreError('VERSION_CONFLICT', '原文已修改，草稿已保留；可明确选择派生资产。', { currentVersionId: row.current_version_id })
    if (carry === 'version' && row.revision !== d.sourceRevision) throw new AssetsStoreError('REVISION_CONFLICT', '生成期间资产已修改；草稿已保留，可明确选择派生。', { currentRevision: row.revision })
    if (carry === 'version' && (name !== undefined || category !== undefined)) throw new AssetsStoreError('BAD_REQUEST', '名称/分类仅适用于派生资产。')
    const content = editedContent ?? d.content, now = new Date().toISOString()
    const version = s.get<{ version: number }>('SELECT version FROM asset_version WHERE id=? AND asset_id=?', d.sourceVersionId, d.assetId)
    if (!version) throw new AssetsStoreError('NOT_FOUND', '来源版本不存在。')
    const provenance = sourceJson(d, version.version, now, content !== d.content, carry === 'derived')
    let resultRow = row
    if (carry === 'version') {
      if (content !== detail(s, row, ctx.layout).currentContent) {
        appendVersion(s, row, content, 'AI 润色/整理采纳', now, null, provenance)
        s.run('UPDATE asset SET revision=revision+1,updated_at=? WHERE id=?', now, row.id)
      }
      resultRow = selectAsset(s, row.id)!
    } else {
      const targetCategory = category ?? row.category
      if (!s.get('SELECT code FROM asset_category WHERE code=?', targetCategory)) throw new AssetsStoreError('BAD_CATEGORY', '派生分类不存在。')
      // 默认名称截短预留后缀；自定义名称经验证而不静默截断。
      const base = name ?? `${row.name.slice(0, 188)}（AI 整理）`
      let targetName = base, seq = 2
      while (s.get('SELECT id FROM asset WHERE name=?', targetName)) { const suffix = ` (${seq++})`; targetName = `${base.slice(0, 200 - suffix.length)}${suffix}` }
      s.run(`INSERT INTO asset(code,name,category,storage_type,source_json,kind,created_at,updated_at) VALUES (?,?,?,'inline_text',?,?,?,?)`,
        `asset-${randomUUID()}`, targetName, targetCategory, provenance, row.kind, now, now)
      const newId = s.get<{ id: number }>('SELECT last_insert_rowid() id')!.id
      appendVersion(s, selectAsset(s, newId)!, content, 'AI 重构整理', now, null, provenance)
      s.run('INSERT INTO asset_reference(source_asset_id,target_asset_id,created_at) VALUES (?,?,?)', newId, row.id, now)
      resultRow = selectAsset(s, newId)!
    }
    s.run('DELETE FROM ai_draft WHERE id=?', d.id)
    return { asset: detail(s, resultRow, ctx.layout), carry: carry as 'version' | 'derived' }
  })
}
