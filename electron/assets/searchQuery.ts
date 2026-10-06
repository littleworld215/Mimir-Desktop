import type { AssetListQuery } from '../../shared/assetsContracts'
import { AssetsStoreError } from './types'
import { assertAssetCode, assertStorageType } from './validation'

export type SearchQuery = AssetListQuery & {
  page: number
  pageSize: number
  q: string
  searchIn: NonNullable<AssetListQuery['searchIn']>
  sort: NonNullable<AssetListQuery['sort']>
  tagIds: number[]
  excludeTagIds: number[]
}
function bad(): never { throw new AssetsStoreError('BAD_REQUEST', '列表参数非法。') }
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) bad()
  return value
}
function numbers(value: unknown, maximum = Infinity): number[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) bad()
  return [...new Set(Array.from(value, positive))]
}
export function readSearchQuery(input: unknown): SearchQuery {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) bad()
  const raw = input as Record<string, unknown>
  const keys = ['page', 'pageSize', 'category', 'kind', 'tagIds', 'tagMode', 'storageType', 'archived',
    'q', 'searchIn', 'sort', 'updatedAfter', 'excludeTagIds', 'ids']
  if (Object.keys(raw).some(key => !keys.includes(key))) bad()
  const page = positive(raw.page ?? 1)
  const pageSize = positive(raw.pageSize ?? 50)
  if (raw.page === null || raw.pageSize === null || pageSize > 200 || !Number.isSafeInteger((page - 1) * pageSize)) bad()
  if (raw.q !== undefined && (typeof raw.q !== 'string' || raw.q.includes('\0'))) bad()
  const q = ((raw.q ?? '') as string).trim()
  if ([...q].length > 200) bad()
  if (raw.searchIn !== undefined && !['all', 'title', 'body', 'source', 'organization'].includes(raw.searchIn as string)) bad()
  if (raw.sort !== undefined && !['relevance', 'updated', 'name'].includes(raw.sort as string)) bad()
  if (raw.kind !== undefined && raw.kind !== null && !['thought', 'rule', 'file', 'prompt'].includes(raw.kind as string)) bad()
  if (raw.archived !== undefined && !['exclude', 'include', 'only'].includes(raw.archived as string)) bad()
  if (raw.tagMode !== undefined && !['and', 'or'].includes(raw.tagMode as string)) bad()
  let category: string | undefined
  try {
    if (raw.category !== undefined) category = assertAssetCode(raw.category)
    if (raw.storageType !== undefined) assertStorageType(raw.storageType)
  } catch { bad() }
  if (raw.updatedAfter !== undefined) {
    if (typeof raw.updatedAfter !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.updatedAfter)) bad()
    const date = new Date(`${raw.updatedAfter}T00:00:00.000Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw.updatedAfter) bad()
  }
  return {
    ...raw as AssetListQuery, category, page, pageSize, q,
    searchIn: (raw.searchIn ?? 'all') as SearchQuery['searchIn'],
    sort: (raw.sort ?? (q ? 'relevance' : 'updated')) as SearchQuery['sort'],
    tagIds: numbers(raw.tagIds), excludeTagIds: numbers(raw.excludeTagIds),
    ids: raw.ids === undefined ? undefined : numbers(raw.ids, 200)
  }
}
export function literalLike(q: string): string { return `%${q.replace(/[\\%_]/g, '\\$&')}%` }
export function literalPhrase(q: string): string { return `"${q.replace(/"/g, '""')}"` }
