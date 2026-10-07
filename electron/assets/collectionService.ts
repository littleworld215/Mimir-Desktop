/** Personal use state is separate from editorial revision and append-only history. */
import type { SavedAssetFilter } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'
import { selectAsset } from './assetRepository'
import { readSearchQuery } from './searchQuery'

function bad(message = '取用参数非法。'): never { throw new AssetsStoreError('BAD_REQUEST', message) }
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad()
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(k => !keys.includes(k))) bad()
  return value
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) bad()
  return value
}
function activeAsset(s: AssetsWriteSession, id: number): void {
  const asset = selectAsset(s, id)
  if (!asset) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
  if (asset.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '资产已归档，请先恢复。')
}

export function setFavorite(ctx: AssetsContext, input: unknown): { favorite: boolean } {
  const v = object(input, ['assetId', 'favorite']), id = positive(v.assetId)
  if (typeof v.favorite !== 'boolean') bad()
  const favorite = v.favorite
  return ctx.write(s => {
    activeAsset(s, id)
    s.run('UPDATE asset SET is_favorite=? WHERE id=? AND is_favorite<>?', favorite ? 1 : 0, id, favorite ? 1 : 0)
    return { favorite }
  })
}

/** Call only after the actual copy/download succeeded; any invalid member rolls back the whole set. */
export function recordUsage(ctx: AssetsContext, input: unknown): { recordedAt: string } {
  const v = object(input, ['assetIds'])
  if (!Array.isArray(v.assetIds) || !v.assetIds.length || v.assetIds.length > 500) bad('请选择1–500项资产。')
  const ids = [...new Set(Array.from(v.assetIds, positive))], recordedAt = new Date().toISOString()
  return ctx.write(s => {
    for (const id of ids) activeAsset(s, id)
    for (const id of ids) s.run('UPDATE asset SET last_used_at=? WHERE id=?', recordedAt, id)
    return { recordedAt }
  })
}

interface FilterRow { id: number; name: string; query_json: string; revision: number; created_at: string; updated_at: string }
function dto(row: FilterRow): SavedAssetFilter {
  return { id: row.id, name: row.name, query: JSON.parse(row.query_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
}
function fields(v: Record<string, unknown>): { name: string; queryJson: string } {
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.trim().length > 80 || v.name.includes('\0')) bad('筛选名称应为1–80字。')
  const { page: _page, pageSize: _size, ids: _ids, ...query } = readSearchQuery(v.query)
  // Key order, set order and omitted defaults must not create editorial conflicts.
  const canonical = {
    ...query, view: query.view ?? 'all', archived: query.archived ?? 'exclude', tagMode: query.tagMode ?? 'and',
    tagIds: [...query.tagIds].sort((a, b) => a - b), excludeTagIds: [...query.excludeTagIds].sort((a, b) => a - b)
  }
  const ordered = Object.fromEntries(Object.entries(canonical).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return { name: v.name.trim(), queryJson: JSON.stringify(ordered) }
}
function filter(s: AssetsWriteSession, id: number, expectedRevision: number): FilterRow {
  const row = s.get<FilterRow>('SELECT * FROM saved_filter WHERE id=?', id)
  if (!row) throw new AssetsStoreError('NOT_FOUND', '保存的筛选不存在。')
  if (row.revision !== expectedRevision) throw new AssetsStoreError('REVISION_CONFLICT', '筛选已修改，请重新加载。', { currentRevision: row.revision })
  return row
}
export function listSavedFilters(ctx: AssetsContext, input:unknown = {}): SavedAssetFilter[] {
  object(input, [])
  return ctx.write(s => s.all<FilterRow>('SELECT * FROM saved_filter ORDER BY updated_at DESC,id DESC').map(dto))
}
export function createSavedFilter(ctx: AssetsContext, input: unknown): SavedAssetFilter {
  const v = object(input, ['name', 'query']), values = fields(v), now = new Date().toISOString()
  return ctx.write(s => {
    s.run('INSERT INTO saved_filter(name,query_json,created_at,updated_at) VALUES (?,?,?,?)', values.name, values.queryJson, now, now)
    const id = s.get<{ id: number }>('SELECT last_insert_rowid() id')!.id
    return dto(s.get<FilterRow>('SELECT * FROM saved_filter WHERE id=?', id)!)
  })
}
export function updateSavedFilter(ctx: AssetsContext, input: unknown): SavedAssetFilter {
  const v = object(input, ['filterId', 'expectedRevision', 'name', 'query']), id = positive(v.filterId), revision = positive(v.expectedRevision), values = fields(v)
  return ctx.write(s => {
    const old = filter(s, id, revision)
    if (old.name !== values.name || old.query_json !== values.queryJson) s.run('UPDATE saved_filter SET name=?,query_json=?,revision=revision+1,updated_at=? WHERE id=?', values.name, values.queryJson, new Date().toISOString(), id)
    return dto(s.get<FilterRow>('SELECT * FROM saved_filter WHERE id=?', id)!)
  })
}
export function deleteSavedFilter(ctx: AssetsContext, input: unknown): { deletedId: number } {
  const v = object(input, ['filterId', 'expectedRevision']), id = positive(v.filterId), revision = positive(v.expectedRevision)
  return ctx.write(s => { filter(s, id, revision); s.run('DELETE FROM saved_filter WHERE id=?', id); return { deletedId: id } })
}
