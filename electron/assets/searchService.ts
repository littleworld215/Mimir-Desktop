import type { AssetPage, AssetSummary } from '../../shared/assetsContracts'
import type { AssetsContext, AssetsWriteSession } from './types'
import { AssetsStoreError } from './types'
import { summary, type AssetRow } from './assetRepository'
import { selectCategory, selectDescendantCodes } from './categoryRepository'
import { literalLike, literalPhrase, readSearchQuery, type SearchQuery } from './searchQuery'

const body = '(SELECT coalesce(v.content,\'\') FROM asset_version v WHERE v.id=a.current_version_id AND v.asset_id=a.id)'
const tags = '(SELECT 1 FROM asset_tag at JOIN tag t ON t.id=at.tag_id WHERE at.asset_id=a.id AND t.name LIKE ? ESCAPE \'\\\')'
const categories = `(WITH RECURSIVE ancestors(code,name,parent_code) AS (
  SELECT code,name,parent_code FROM asset_category WHERE code=a.category
  UNION SELECT c.code,c.name,c.parent_code FROM asset_category c JOIN ancestors p ON c.code=p.parent_code
) SELECT 1 FROM ancestors WHERE name LIKE ? ESCAPE '\\')`
const like = (field: string) => `coalesce(${field},'') LIKE ? ESCAPE '\\'`
const fold = (text: string) => text.toLowerCase()

/** Bounds by code points; offsets stay UTF-16 for direct React text slicing. */
export function searchExcerpt(text: string, q: string): NonNullable<AssetSummary['excerpt']> {
  // Lowercasing may expand a character (İ); map folded positions back to original UTF-16 offsets.
  const positions = (value: string) => {
    const starts: number[] = []
    const ends: number[] = []
    let originalOffset = 0
    for (const char of value) {
      for (let i = 0; i < fold(char).length; i++) { starts.push(originalOffset); ends.push(originalOffset + char.length) }
      originalOffset += char.length
    }
    return { starts, ends }
  }
  const index = fold(text).indexOf(fold(q))
  const originalIndex = index < 0 ? 0 : positions(text).starts[index]
  const start = Math.max(0, [...text.slice(0, originalIndex)].length - 45)
  const excerpt = [...text].slice(start, start + 180).join('')
  const matches: Array<{ start: number; end: number }> = []
  const folded = fold(excerpt)
  const map = positions(excerpt)
  const needle = fold(q)
  let offset = 0
  while (needle && (offset = folded.indexOf(needle, offset)) >= 0) {
    matches.push({ start: map.starts[offset], end: map.ends[offset + needle.length - 1] })
    offset += needle.length
  }
  return { text: excerpt, matches }
}

export function searchAssets(ctx: AssetsContext, payload: unknown = {}): AssetPage {
  const query = readSearchQuery(payload)
  return ctx.write(s => searchAssetsInSession(s, query))
}

/** Export owns one session; nested ctx.write would invalidate its outer guarded session. */
export function searchAssetsInSession(s: AssetsWriteSession, query: SearchQuery): AssetPage {
    const where: string[] = []
    const params: unknown[] = []
    const add = (sql: string, ...values: unknown[]) => { where.push(sql); params.push(...values) }
    if (query.archived === 'only') add('a.archived_at IS NOT NULL')
    else if (query.archived !== 'include') add('a.archived_at IS NULL')
    if (query.category !== undefined) {
      if (!selectCategory(s, query.category)) throw new AssetsStoreError('BAD_CATEGORY', '分类不存在。')
      const codes = [query.category, ...selectDescendantCodes(s, query.category)]
      add(`a.category IN (${codes.map(() => '?').join(',')})`, ...codes)
    }
    if (query.kind !== undefined) add(query.kind === null ? 'a.kind IS NULL' : 'a.kind=?', ...(query.kind === null ? [] : [query.kind]))
    if (query.storageType !== undefined) add('a.storage_type=?', query.storageType)
    if (query.updatedAfter !== undefined) add('a.updated_at>=?', `${query.updatedAfter}T00:00:00.000Z`)
    if (query.ids !== undefined) add(query.ids.length ? `a.id IN (${query.ids.map(() => '?').join(',')})` : '0', ...query.ids)
    if (query.tagIds.length) {
      const or = query.tagMode === 'or'
      add(`a.id IN (SELECT asset_id FROM asset_tag WHERE tag_id IN (${query.tagIds.map(() => '?').join(',')}) GROUP BY asset_id${or ? '' : ' HAVING count(DISTINCT tag_id)=?'})`, ...query.tagIds, ...(or ? [] : [query.tagIds.length]))
    }
    if (query.excludeTagIds.length) add(`NOT EXISTS (SELECT 1 FROM asset_tag WHERE asset_id=a.id AND tag_id IN (${query.excludeTagIds.map(() => '?').join(',')}))`, ...query.excludeTagIds)
    const pattern = literalLike(query.q)
    const long = [...query.q].length >= 3
    if (query.q) {
      if (query.searchIn === 'organization') add(`(${like('a.name')} OR EXISTS ${tags} OR EXISTS ${categories})`, pattern, pattern, pattern)
      else if (long) {
        const columns = { all: '', title: 'name : ', body: 'content : ', source: 'source_task : ' }
        add('a.id IN (SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?)', columns[query.searchIn] + literalPhrase(query.q))
      } else {
        const fields = query.searchIn === 'title' ? ['a.name'] : query.searchIn === 'body' ? [body] : query.searchIn === 'source' ? ['a.source_task'] : ['a.name', 'a.description', 'a.notes', 'a.source_task', body]
        add(`(${fields.map(like).join(' OR ')})`, ...fields.map(() => pattern))
      }
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const total = s.get<{ n: number }>(`SELECT count(*) n FROM asset a${clause}`, ...params)?.n ?? 0
    let order = 'a.updated_at DESC,a.id DESC'
    const rankParams: unknown[] = []
    if (query.sort === 'name') order = 'a.name COLLATE NOCASE,a.id'
    if (query.q && query.sort === 'relevance') {
      const fieldRank = (field: string, column: string, score: number): [string, number, string] => long && query.searchIn !== 'organization'
        ? ['a.id IN (SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?)', score, `${column} : ${literalPhrase(query.q)}`]
        : [like(field), score, pattern]
      const conditions: Array<[string, number, string]> = [fieldRank('a.name', 'name', 100), [`EXISTS ${tags}`, 60, pattern]]
      if (query.searchIn === 'organization') conditions.push([`EXISTS ${categories}`, 30, pattern])
      conditions.push(fieldRank('a.description', 'description', 30), fieldRank('a.notes', 'notes', 30), fieldRank('a.source_task', 'source_task', 30), fieldRank(body, 'content', 10))
      order = `CASE ${conditions.map(([condition, score, value]) => { rankParams.push(value); return `WHEN ${condition} THEN ${score}` }).join(' ')} ELSE 0 END DESC,${order}`
    }
    const rows = s.all<AssetRow>(`SELECT a.* FROM asset a${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, ...rankParams, query.pageSize, (query.page - 1) * query.pageSize)
    const items = rows.map(row => {
      const item = summary(s, row)
      if (query.q) {
        const candidates = query.searchIn === 'body' ? [] : query.searchIn === 'source' ? [row.source_task] : query.searchIn === 'title' ? [row.name] : [row.name, row.description, row.notes, row.source_task]
        if (query.searchIn === 'organization') candidates.push(...item.tags.map(t => t.name), ...item.categoryPath)
        let match = candidates.find(text => fold(text).includes(fold(query.q)))
        if (match === undefined && ['all', 'body'].includes(query.searchIn) && row.current_version_id !== null) {
          // Read only a bounded window of this page's current body; no whole-library body cache.
          match = long
            ? s.get<{ text: string }>(`SELECT substr(snippet(asset_fts,4,'','','',64),1,180) text FROM asset_fts WHERE rowid=? AND asset_fts MATCH ?`, row.id, `content : ${literalPhrase(query.q)}`)?.text
            : s.get<{ text: string }>(`SELECT substr(content,max(1,instr(lower(content),lower(?))-45),180) text FROM asset_version WHERE id=? AND asset_id=?`, query.q, row.current_version_id, row.id)?.text
        }
        item.excerpt = searchExcerpt(match ?? row.name, query.q)
      }
      return item
    })
    return { items, total, page: query.page, pageSize: query.pageSize }
}
