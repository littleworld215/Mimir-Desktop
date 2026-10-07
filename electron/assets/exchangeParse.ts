/** Pure validation before any mutation; malformed template configuration is never bypassed by skipping. */
import { createHash } from 'node:crypto'
import { ASSET_TRANSFER_MAX_BYTES, type AssetImportMode, type ExchangeAsset } from '../../shared/assetsContracts'
import { AssetsStoreError } from './types'
import { assertAssetCode, assertAssetName, assertStorageType, assertContentBytes, assertExternalUrl, assertSourceObject, assertTemplateConfig, assertTagName, assertTagCount } from './validation'
import { normalizeTagName } from './tagNormalization'

export interface ParsedImport {
  raw: string
  mode: AssetImportMode
  skipIndexes: number[]
  rows: Array<{ index: number; asset: ExchangeAsset | null; error?: string; fatal: boolean }>
}
function bad(message: string): never { throw new AssetsStoreError('BAD_REQUEST',message) }
function object(v: unknown): Record<string,unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('参数或资产必须为对象。')
  return v as Record<string,unknown>
}
function text(v: unknown, fallback = ''): string {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'string' || v.includes('\u0000')) bad('文本字段非法。')
  return v
}
function date(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) bad('时间字段非法。')
  return new Date(v).toISOString()
}
function asset(v: Record<string,unknown>, index: number): ExchangeAsset {
  if (Object.keys(v).some(k => /^(filePath|currentFilePath|databasePath|sourcePath|targetPath|file_path)$/.test(k))) bad('交换内容不能携带文件路径。')
  const storageType = assertStorageType(v.storageType ?? 'inline_text')
  const code = v.code === undefined ? `import-${createHash('sha256').update(JSON.stringify(v)).update(String(index)).digest('hex').slice(0,24)}` : assertAssetCode(v.code)
  const category = v.category == null ? '' : assertAssetCode(v.category)
  let categoryPath: string[] = []
  if (v.categoryPath !== undefined) {
    if (!Array.isArray(v.categoryPath) || v.categoryPath.length === 0 || v.categoryPath.length > 100) bad('分类路径非法。')
    categoryPath = Array.from(v.categoryPath,assertAssetName)
  }
  if (!category && !categoryPath.length) bad('缺少分类或分类路径。')
  const content = storageType === 'inline_text' ? assertContentBytes(v.content ?? '') : null
  if (storageType !== 'inline_text' && v.content != null && v.content !== '') bad('此形态不能导入正文。')
  const externalUrl = storageType === 'external_link' ? assertExternalUrl(v.externalUrl) : null
  if (storageType !== 'external_link' && v.externalUrl != null && v.externalUrl !== '') bad('非外链不能导入URL。')
  if (v.kind != null && !['thought','rule','file','prompt'].includes(v.kind as string)) bad('kind非法。')
  let source: unknown = v.sourceJson === undefined ? {} : JSON.parse(text(v.sourceJson))
  if (v.aiGenerated === true) source = { ...object(source), aiGenerated: true }
  const sourceJson = assertSourceObject(object(source))
  const rawTags = v.tags ?? []
  if (!Array.isArray(rawTags)) bad('标签必须为数组。')
  assertTagCount(rawTags.length)
  const tags = new Map<string,{name:string;color:string|null}>()
  for (const t of rawTags) {
    const tag = typeof t === 'string' ? { name: t } : object(t)
    const name = assertTagName(tag.name), color = tag.color == null ? null : text(tag.color)
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) bad('标签颜色非法。')
    tags.set(normalizeTagName(name),{name,color})
  }
  if (v.references !== undefined && !Array.isArray(v.references)) bad('参见必须为数组。')
  const references = [...new Set(Array.from((v.references ?? []) as unknown[], r => assertAssetCode(typeof r === 'string' ? r : object(r).code)))]
  if (v.isFavorite !== undefined && v.isFavorite !== 0 && v.isFavorite !== 1) bad('收藏值非法。')
  return {
    code, name: assertAssetName(v.name), category, categoryPath, storageType, content, externalUrl,
    description: text(v.description), notes: text(v.notes), sourceTask: text(v.sourceTask), sourceJson,
    kind: (v.kind ?? null) as ExchangeAsset['kind'], templateConfig: assertTemplateConfig(v.templateConfig),
    tags: [...tags.values()], references, contentVersion: null, currentFileName: v.currentFileName == null ? null : text(v.currentFileName),
    isFavorite: (v.isFavorite ?? 0) as 0|1, lastUsedAt: date(v.lastUsedAt), archivedAt: date(v.archivedAt)
  }
}
export function parseImport(input: unknown, committing = false): ParsedImport {
  const v = object(input)
  const allowed = ['raw','mode','skipIndexes',...(committing ? ['previewToken'] : [])]
  if (Object.keys(v).some(k=>!allowed.includes(k))) bad('导入含未知字段。')
  if (typeof v.raw !== 'string' || Buffer.byteLength(v.raw,'utf8') > ASSET_TRANSFER_MAX_BYTES) bad('JSON必须为文本且不超过200MiB。')
  const mode = v.mode ?? 'skip'
  if (!['skip','overwrite','copy'].includes(mode as string)) bad('导入策略非法。')
  let parsed: unknown
  try { parsed = JSON.parse(v.raw) } catch { bad('JSON解析失败。') }
  const items = Array.isArray(parsed) ? parsed : object(parsed).assets
  if (!Array.isArray(items)) bad('JSON缺少assets数组。')
  if (v.skipIndexes !== undefined && !Array.isArray(v.skipIndexes)) bad('跳过行必须为数组。')
  const skipIndexes = [...new Set(Array.from((v.skipIndexes ?? []) as unknown[], x => {
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 1 || x > items.length) bad('跳过行号非法。')
    return x
  }))].sort((a,b)=>a-b)
  const rows = Array.from(items,(raw,index) => {
    let fatal = false
    try {
      const row = object(raw)
      try { assertTemplateConfig(row.templateConfig) } catch { fatal = true; bad('模板配置非法，整批拒绝。') }
      return { index: index+1, asset: asset(row,index+1), fatal }
    } catch (error) { return { index: index+1, asset: null, fatal, error: error instanceof Error ? error.message : '资产非法。' } }
  })
  return { raw: v.raw, mode: mode as AssetImportMode, skipIndexes, rows }
}
