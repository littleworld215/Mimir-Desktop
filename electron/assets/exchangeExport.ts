/** Portable JSON/Markdown export from one guarded read snapshot, without filesystem writes. */
import type { AssetExportRequest, AssetExportResult, ExchangeAsset, ExchangeDocument } from '../../shared/assetsContracts'
import { ASSET_TRANSFER_MAX_BYTES } from '../../shared/assetsContracts'
import { detail, selectAsset } from './assetRepository'
import { readSearchQuery } from './searchQuery'
import { searchAssetsInSession } from './searchService'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'
import { assertSourceObject } from './validation'

function bad(message = '导出参数非法。'): never { throw new AssetsStoreError('BAD_REQUEST', message) }
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) bad()
  return input as Record<string, unknown>
}
function request(input: unknown): AssetExportRequest {
  const raw = object(input)
  if (Object.keys(raw).some(key => !['format', 'query', 'ids', 'ai'].includes(key))) bad()
  if (raw.format !== undefined && !['json', 'markdown'].includes(raw.format as string)) bad()
  if (raw.ai !== undefined && !['include', 'original-only'].includes(raw.ai as string)) bad()
  const query = raw.query === undefined ? {} : object(raw.query)
  if (['page', 'pageSize', 'ids'].some(key => Object.hasOwn(query, key))) bad('导出筛选不能包含分页或内部ID筛选。')
  readSearchQuery(query)
  if (raw.ids !== undefined) {
    if (!Array.isArray(raw.ids) || raw.ids.length > 500) bad('最多导出500个所选资产。')
    for (const id of Array.from(raw.ids)) if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) bad()
  }
  return { format: (raw.format ?? 'json') as AssetExportRequest['format'], query, ids: raw.ids === undefined ? undefined : [...new Set(raw.ids as number[])], ai: (raw.ai ?? 'include') as AssetExportRequest['ai'] }
}
function aiGenerated(source: string): boolean {
  try { return JSON.parse(source)?.aiGenerated === true } catch { return false }
}
function bound(content: string): string {
  if (Buffer.byteLength(content, 'utf8') > ASSET_TRANSFER_MAX_BYTES) bad('导出超过200MiB，请缩小筛选范围或分批导出。')
  return content
}
export function portable(s: AssetsWriteSession, id: number, originalOnly: boolean): ExchangeAsset | null {
  const row = selectAsset(s, id)
  if (!row) throw new AssetsStoreError('NOT_FOUND', '资产已不存在，请刷新选择。')
  if (originalOnly && aiGenerated(row.source_json)) return null
  // No layout means no filesystem availability probes: binary bytes are deliberately outside JSON exchange.
  const asset = detail(s, row)
  const original = originalOnly && asset.storageType === 'inline_text' ? s.get<{ content: string; version: number }>(
    `SELECT content,version FROM asset_version WHERE asset_id=? AND
      (CASE WHEN json_valid(source_json) THEN json_type(source_json,'$.aiGenerated') ELSE NULL END) IS NOT 'true'
      ORDER BY version DESC LIMIT 1`, id) : undefined
  // JSON交换只带一个正文快照：含AI时把本版溯源带出，避免再导入后AI正文变成原文。
  // 不更改库内资产级来源；仅原文分支仍沿用资产级元信息。
  const versionSource = originalOnly || row.current_version_id === null ? undefined : s.get<{ source_json: string }>(
    'SELECT source_json FROM asset_version WHERE id=? AND asset_id=?', row.current_version_id, id)?.source_json
  let sourceJson = asset.sourceJson
  if (versionSource && aiGenerated(versionSource)) {
    try { sourceJson = assertSourceObject({ ...JSON.parse(asset.sourceJson), ...JSON.parse(versionSource) }) }
    catch { bad('导出AI版本来源超过64KiB或格式非法，请缩小来源信息。') }
  }
  return {
    code: asset.code, name: asset.name, category: asset.category, categoryPath: asset.categoryPath,
    description: asset.description, storageType: asset.storageType, externalUrl: asset.externalUrl,
    sourceJson, sourceTask: asset.sourceTask, notes: asset.notes, kind: asset.kind,
    templateConfig: asset.templateConfig, tags: asset.tags.map(tag => ({ name: tag.name, color: tag.color })),
    references: s.all<{ code: string }>('SELECT a.code FROM asset_reference r JOIN asset a ON a.id=r.target_asset_id WHERE r.source_asset_id=? ORDER BY a.code', id).map(ref => ref.code),
    content: asset.storageType === 'file' ? null : original?.content ?? asset.currentContent,
    contentVersion: original?.version ?? asset.currentVersion,
    currentFileName: asset.currentFileName, isFavorite: asset.isFavorite,
    lastUsedAt: asset.lastUsedAt, archivedAt: asset.archivedAt,
    ...(aiGenerated(sourceJson) ? { aiGenerated: true as const } : {})
  }
}
function markdown(document: ExchangeDocument): string {
  const categories = new Map<string, ExchangeAsset[]>()
  const names = new Map(document.assets.map(asset => [asset.code, asset.name]))
  for (const asset of document.assets) {
    const path = asset.categoryPath.join(' / ')
    const group = categories.get(path) ?? []
    group.push(asset); categories.set(path, group)
  }
  const parts = [`# 科研资产库导出\n\n导出日期：${document.exportedAt.slice(0, 10)}　条目数：${document.count}\n`]
  const labels = { thought: '任务思路', rule: '规则', file: '文件资料', prompt: 'Prompt' }
  for (const [category, assets] of categories) {
    parts.push(`\n## ${category}\n`)
    for (const asset of assets) {
      parts.push(`\n### ${asset.name}\n\n- 类型：${asset.kind ? labels[asset.kind] : '普通资产'}　|　分类：${category}\n`)
      if (asset.sourceTask) parts.push(`- 来源任务：${asset.sourceTask}\n`)
      if (asset.notes) parts.push(`- 备注：${asset.notes}\n`)
      if (asset.tags.length) parts.push(`- 标签：${asset.tags.map(tag => tag.name).join('、')}\n`)
      if (asset.references.length) parts.push(`- 参见：${asset.references.map(code => `${names.get(code) ?? code}（${code}）`).join('、')}\n`)
      if (asset.aiGenerated) parts.push('- ⚠ AI 生成\n')
      parts.push(asset.storageType === 'file' ? `\n> 文件类型条目：${asset.currentFileName ?? '（文件）'}（二进制内容不导出）\n`
        : asset.storageType === 'external_link' ? `\n外链：${asset.externalUrl}\n` : `\n${asset.content ?? ''}\n`)
    }
  }
  return bound(parts.join(''))
}

/** Export is explicit whole-body consumption; ordinary list pagination/body reads remain unchanged. */
export function exportAssets(ctx: AssetsContext, input: unknown = {}): AssetExportResult {
  const parsed = request(input), selected = parsed.ids === undefined ? undefined : new Set(parsed.ids)
  const exportedAt = new Date().toISOString()
  const assets = ctx.write(s => {
    const result: ExchangeAsset[] = [], found = new Set<number>()
    let bytes = 0, page = 1
    if (selected?.size === 0) return result
    for (;;) {
      // Public list keeps its 200-ID bound; export separately validates its source-compatible 500 IDs.
      const batch = searchAssetsInSession(s, { ...readSearchQuery({ ...parsed.query, page, pageSize: 200 }), ids: parsed.ids })
      for (const item of batch.items) {
        if (selected && !selected.has(item.id)) continue
        found.add(item.id)
        const asset = portable(s, item.id, parsed.ai === 'original-only')
        if (asset) {
          // Markdown does not JSON-escape newlines. This lower bound limits accumulated body memory;
          // the final serializer checks its actual complete UTF-8 output, including all markup.
          bytes += Buffer.byteLength(parsed.format === 'markdown'
            ? asset.storageType === 'inline_text' ? asset.content ?? '' : asset.externalUrl ?? ''
            : JSON.stringify(asset), 'utf8')
          if (bytes > ASSET_TRANSFER_MAX_BYTES) bad('导出超过200MiB，请分批导出。')
          result.push(asset)
        }
      }
      if (page * batch.pageSize >= batch.total) break
      page++
    }
    if (selected && found.size !== selected.size) throw new AssetsStoreError('NOT_FOUND', '部分所选资产不存在或不在当前筛选范围，请刷新选择。')
    return result
  })
  const document: ExchangeDocument = { exportedAt, count: assets.length, assets }
  const format = parsed.format ?? 'json'
  return { format, count: assets.length, fileName: `资产导出-${exportedAt.slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`, content: format === 'json' ? bound(JSON.stringify(document, null, 2)) : markdown(document) }
}
