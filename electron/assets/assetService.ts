import { randomUUID } from 'node:crypto'
import type { AssetCreateInput, AssetPatch, AssetDetail, WriteCondition } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext } from './types'
import { assertAssetCode, assertAssetName, assertContentBytes, assertExternalUrl, assertStorageType, assertSourceObject, assertTemplateConfig, assertTagName, assertTagCount } from './validation'
import { selectCategory } from './categoryRepository'
import { appendVersion, assetTags, detail, selectAsset, type AssetRow } from './assetRepository'
import { replaceTags } from './tagRepository'
import { normalizeTagName } from './tagNormalization'

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new AssetsStoreError('BAD_REQUEST', '参数必须是对象。')
  return input as Record<string, unknown>
}
function positive(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) throw new AssetsStoreError('BAD_REQUEST', '参数必须为正安全整数。')
  return input
}
function text(input: unknown): string {
  if (typeof input !== 'string' || input.includes('\u0000')) throw new AssetsStoreError('BAD_REQUEST', '文本参数非法。')
  return input
}
function validate(payload: unknown, create: boolean): Record<string, unknown> {
  const v = object(payload)
  const allowed = ['name','category','description','content','externalUrl','notes','source','sourceTask','kind','templateConfig','tagNames','changelog']
  if (create) allowed.push('code','storageType')
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new AssetsStoreError('BAD_REQUEST', '含未知或不可修改字段。')
  const out: Record<string, unknown> = { ...v }
  try {
    if (create || v.name !== undefined) out.name = assertAssetName(v.name)
    if (create || v.category !== undefined) out.category = assertAssetCode(v.category)
    if (v.code !== undefined) out.code = assertAssetCode(v.code)
    if (create) out.storageType = assertStorageType(v.storageType)
    if (v.content !== undefined) out.content = assertContentBytes(v.content)
    for (const key of ['description','notes','sourceTask','changelog']) if (v[key] !== undefined) out[key] = text(v[key])
    if (v.externalUrl !== undefined) out.externalUrl = assertExternalUrl(v.externalUrl)
    if (v.kind !== undefined && v.kind !== null && !['thought','rule','file','prompt'].includes(v.kind as string)) throw new AssetsStoreError('BAD_KIND', 'kind 非法。')
    if (v.source !== undefined) {
      if (v.source === null) throw new AssetsStoreError('BAD_REQUEST', 'source必须为对象。')
      out.source = assertSourceObject(v.source)
    }
    if (v.templateConfig !== undefined) {
      try { out.templateConfig = JSON.stringify(assertTemplateConfig(v.templateConfig)) } catch { throw new AssetsStoreError('BAD_TEMPLATE_CONFIG', '模板配置非法。') }
    }
    if (v.tagNames !== undefined) {
      if (!Array.isArray(v.tagNames)) throw new AssetsStoreError('BAD_REQUEST', '标签必须为数组。')
      assertTagCount(v.tagNames.length)
      out.tagNames = [...new Map(v.tagNames.map(raw => { const name = assertTagName(raw); return [normalizeTagName(name),name] })).values()]
    }
  } catch (error) {
    if (error instanceof AssetsStoreError) throw error
    throw new AssetsStoreError('BAD_REQUEST', error instanceof Error ? error.message : '参数非法。')
  }
  return out
}

/** 三形态建资产；文件空壳不建版本，其它形态建v1。 */
export function createAsset(ctx: AssetsContext, payload: unknown): AssetDetail {
  const v = validate(payload, true)
  const input = v as unknown as AssetCreateInput
  const type = input.storageType
  if (type === 'external_link' && input.externalUrl === undefined) throw new AssetsStoreError('BAD_REQUEST', '外链必须提供http(s) URL。')
  if (type !== 'external_link' && input.externalUrl !== undefined) throw new AssetsStoreError('BAD_REQUEST', '非外链不能输入URL。')
  if (type !== 'inline_text' && input.content !== undefined && input.content !== '') throw new AssetsStoreError('BAD_REQUEST', '此形态不能输入正文。')
  return ctx.write(s => {
    if (selectCategory(s, input.category) === undefined) throw new AssetsStoreError('BAD_CATEGORY', '分类不存在。')
    const code = input.code ?? `asset-${randomUUID()}`
    if (s.get('SELECT id FROM asset WHERE code=?', code) !== undefined) throw new AssetsStoreError('DUPLICATE_CODE', 'code已存在。')
    const now = new Date().toISOString()
    s.run(`INSERT INTO asset(code,name,category,description,storage_type,external_url,source_json,source_task,notes,kind,template_config,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, code,input.name,input.category,input.description ?? '',type,input.externalUrl ?? null,
      v.source ?? '{}',input.sourceTask ?? '',input.notes ?? '',input.kind ?? null,v.templateConfig ?? '{"version":1,"variables":{}}',now,now)
    const id = s.get<{ id: number }>('SELECT last_insert_rowid() id')?.id as number
    const row = selectAsset(s,id) as AssetRow
    if (type !== 'file') appendVersion(s,row,type === 'inline_text' ? input.content ?? '' : '',input.changelog ?? '',now)
    replaceTags(s,id,(v.tagNames ?? []) as string[])
    return detail(s,selectAsset(s,id) as AssetRow,ctx.layout)
  })
}

/** 条件更新所有元信息、标签与版本；任何失败整个事务回滚。 */
export function updateAsset(ctx: AssetsContext, id: number, condition: unknown, payload: unknown): AssetDetail {
  positive(id)
  const c = object(condition)
  if (Object.keys(c).some(k => !['expectedRevision','expectedCurrentVersionId'].includes(k))) throw new AssetsStoreError('BAD_REQUEST', '条件参数非法。')
  positive(c.expectedRevision)
  const hasVersionCondition = Object.hasOwn(c, 'expectedCurrentVersionId')
  if (hasVersionCondition && c.expectedCurrentVersionId !== null) positive(c.expectedCurrentVersionId)
  const v = validate(payload,false)
  return ctx.write(s => {
    const row = selectAsset(s,id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    if (row.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
    if (row.revision !== c.expectedRevision) throw new AssetsStoreError('REVISION_CONFLICT', '资产已更新。', { currentRevision: row.revision })
    if (hasVersionCondition && c.expectedCurrentVersionId !== row.current_version_id) {
      throw new AssetsStoreError('VERSION_CONFLICT', '正文版本已改变。', { currentVersionId: row.current_version_id })
    }
    if (v.content !== undefined) {
      if (row.storage_type !== 'inline_text') throw new AssetsStoreError('BAD_REQUEST', '只能编辑文本资产正文。')
      if (!hasVersionCondition) throw new AssetsStoreError('BAD_REQUEST', '正文编辑必须提供当前版本条件。')
    }
    if (v.externalUrl !== undefined && row.storage_type !== 'external_link') throw new AssetsStoreError('BAD_REQUEST','非外链不能输入URL。')
    if (v.category !== undefined && selectCategory(s,v.category as string) === undefined) throw new AssetsStoreError('BAD_CATEGORY','分类不存在。')
    const columns: Record<string,string> = { name:'name',category:'category',description:'description',externalUrl:'external_url',source:'source_json',sourceTask:'source_task',notes:'notes',kind:'kind',templateConfig:'template_config' }
    const sets: string[] = []
    const params: unknown[] = []
    for (const [key,column] of Object.entries(columns)) if (v[key] !== undefined && v[key] !== row[column as keyof AssetRow]) { sets.push(`${column}=?`); params.push(v[key]) }
    const before = detail(s,row,ctx.layout)
    const contentChanged = v.content !== undefined && v.content !== before.currentContent
    const requestedTags = v.tagNames as string[] | undefined
    const currentTags = assetTags(s,id).map(t=>normalizeTagName(t.name)).sort()
    const tagsChanged = requestedTags !== undefined && JSON.stringify(requestedTags.map(normalizeTagName).sort()) !== JSON.stringify(currentTags)
    if (sets.length === 0 && !contentChanged && !tagsChanged) return before
    const now = new Date().toISOString()
    sets.push('revision=revision+1','updated_at=?'); params.push(now,id)
    s.run(`UPDATE asset SET ${sets.join(',')} WHERE id=?`,...params)
    if (contentChanged) appendVersion(s,selectAsset(s,id) as AssetRow,v.content as string,(v.changelog ?? '') as string,now)
    if (tagsChanged) replaceTags(s,id,requestedTags as string[])
    return detail(s,selectAsset(s,id) as AssetRow,ctx.layout)
  })
}

export function getAsset(ctx: AssetsContext, id: number): AssetDetail {
  positive(id)
  return ctx.write(s => { const row = selectAsset(s,id); if (row === undefined) throw new AssetsStoreError('NOT_FOUND','资产不存在。'); return detail(s,row,ctx.layout) })
}

/** 保留I1服务入口，查询合同在独立服务中统一校验。 */
export { searchAssets as listAssets } from './searchService'
