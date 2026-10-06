import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, updateAsset, listAssets } from '../../../electron/assets/assetService'
import { createCategory } from '../../../electron/assets/categoryService'

let root: string
let manager: AssetsStoreManager
let ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-search-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
function create(extra: Record<string, unknown> = {}) {
  return createAsset(ctx, { name: 'Asset', category: 'inbox', storageType: 'inline_text', content: '', ...extra })
}
function ids(query: Record<string, unknown>) { return listAssets(ctx, query).items.map(a => a.id) }

it('短词与长词覆盖五字段，旧版本正文不参与', () => {
  for (const token of ['科研', 'scientific']) {
    const assets = ['name', 'description', 'notes', 'sourceTask', 'content'].map(field => create({ [field]: token }))
    const old = create({ content: token })
    updateAsset(ctx, old.id, { expectedRevision: old.revision, expectedCurrentVersionId: old.currentVersionId }, { content: 'replacement' })
    expect(new Set(ids({ q: token }))).toEqual(new Set(assets.map(a => a.id)))
    expect(ids({ q: token, searchIn: 'body' })).toEqual([assets[4].id])
    expect(ids({ q: token, searchIn: 'source' })).toEqual([assets[3].id])
    expect(ids({ q: token, searchIn: 'title' })).toEqual([assets[0].id])
  }
})
it('空格trim、emoji、LIKE通配符及FTS操作符均作字面文本', () => {
  for (const token of ['%', '_', '\\', '😀', '😀🧪🔬', 'a"b', 'OR', 'a OR b', '<script>']) {
    const a = create({ name: `literal ${token} end` })
    expect(ids({ q: ` ${token} ` })).toContain(a.id)
    expect(ids({ q: token })).not.toContain(create({ name: 'unrelated' }).id)
  }
  expect(listAssets(ctx, { q: '  ' }).total).toBeGreaterThan(0)
})
it('组织范围匹配标签与祖先分类，普通全文范围不扩张', () => {
  createCategory(ctx, { code: 'parent', name: '科学研究' })
  createCategory(ctx, { code: 'child', name: 'Child', parentCode: 'parent' })
  const a = create({ category: 'child', tagNames: ['组织专用'] })
  expect(ids({ q: '科学', searchIn: 'organization' })).toEqual([a.id])
  expect(ids({ q: '组织专用', searchIn: 'organization' })).toEqual([a.id])
  expect(ids({ q: '科学' })).toEqual([])
  expect(ids({ q: '组织专用' })).toEqual([])
})
it('组合筛选、标签与或/排除、日期、ids、归档、稳定分页共用count条件', () => {
  const a = create({ name: 'alpha', content: 'match', tagNames: ['A', 'B'] })
  const b = create({ name: 'beta', content: 'match', tagNames: ['A'], kind: 'prompt' })
  ctx.write(s => {
    s.run('UPDATE asset SET updated_at=?', '2026-10-07T00:00:00.000Z')
    s.run('UPDATE asset SET archived_at=? WHERE id=?', '2026-10-07', b.id)
  })
  const query = { q: 'match', category: 'inbox', kind: null, storageType: 'inline_text', tagIds: a.tags.map(t => t.id), updatedAfter: '2026-10-07', ids: [a.id, b.id] }
  expect(listAssets(ctx, query)).toMatchObject({ total: 1, items: [{ id: a.id }] })
  expect(listAssets(ctx, { ...query, excludeTagIds: [a.tags[1].id] }).total).toBe(0)
  expect(listAssets(ctx, { q: 'match', archived: 'include', tagIds: a.tags.map(t => t.id), tagMode: 'or', pageSize: 1 })).toMatchObject({ total: 2, items: [{ id: b.id }] })
  expect(ids({ q: 'match', archived: 'include', pageSize: 1, page: 2 })).toEqual([a.id])
  expect(ids({ q: 'match', archived: 'only' })).toEqual([b.id])
  expect(ids({ archived: 'include', sort: 'name' })).toEqual([a.id, b.id])
  expect(ids({ ids: [] })).toEqual([])
  expect(ids({ updatedAfter: '2026-10-08' })).toEqual([])
})
it('相关度标题优于元信息优于正文，显式updated覆盖评分', () => {
  const title = create({ name: 'needle' })
  const meta = create({ notes: 'needle' })
  const body = create({ content: 'needle' })
  ctx.write(s => s.run('UPDATE asset SET updated_at=?', 'same'))
  expect(ids({ q: 'needle' })).toEqual([title.id, meta.id, body.id])
  expect(ids({ q: 'needle', sort: 'updated' })).toEqual([body.id, meta.id, title.id])
})
it('非法参数拒绝，200个Unicode字符合法，日期按真实日历验证', () => {
  for (const query of [{ q: 1 }, { q: 'a\0' }, { q: '😀'.repeat(201) }, { searchIn: 'bad' }, { sort: 'bad' }, { ids: [0] }, { ids: Array(201).fill(1) }, { excludeTagIds: ['1'] }, { updatedAfter: '2026-02-29' }, { updatedAfter: '2026-13-01' }, { page: Number.MAX_SAFE_INTEGER }, { unknown: 1 }]) {
    expect(() => listAssets(ctx, query)).toThrow()
  }
  expect(listAssets(ctx, { q: '😀'.repeat(200), updatedAfter: '2024-02-29' }).total).toBe(0)
})
it('片段限180码点，offset为UTF16，HTML只返回普通文本，无全文泄漏', () => {
  const a = create({ content: '😀'.repeat(90) + '<script>needle</script>' + '🧪'.repeat(200) })
  const item = listAssets(ctx, { q: 'needle' }).items[0] as typeof a & { excerpt: { text: string; matches: { start: number; end: number }[] } }
  expect([...item.excerpt.text].length).toBeLessThanOrEqual(180)
  expect(item.excerpt.text).toContain('<script>needle</script>')
  for (const match of item.excerpt.matches) expect(item.excerpt.text.slice(match.start, match.end)).toBe('needle')
  expect(item).not.toHaveProperty('currentContent')
  expect(listAssets(ctx).items[0]).not.toHaveProperty('excerpt')
})
it('FTS故障报错，不静默缩减检索范围', () => {
  create({ sourceTask: 'needle' })
  ctx.write(s => s.run('DROP TABLE asset_fts'))
  expect(() => listAssets(ctx, { q: 'needle' })).toThrow()
})
it('通配符及引号不扩张到近似匹配，长短词与范围结果完全一致', () => {
  const exact = create({ name: 'a%b', notes: 'a_b', sourceTask: 'a\\b', content: 'x"y' })
  create({ name: 'axb', notes: 'acb', sourceTask: 'a/b', content: 'xyz' })
  for (const [q, searchIn] of [['%', 'title'], ['a%b', 'title'], ['_', 'all'], ['a_b', 'all'], ['\\', 'source'], ['a\\b', 'source'], ['x"y', 'body']]) {
    expect(ids({ q, searchIn })).toEqual([exact.id])
  }
  expect(ids({ q: 'x OR y', searchIn: 'all' })).toEqual([])
})
it('查询不修改请求对象，旧分页与显式null保持原合同', () => {
  const query = Object.freeze({ category: 'inbox', kind: null, tagIds: Object.freeze([]) })
  expect(listAssets(ctx, query).total).toBe(0)
  expect(listAssets(ctx, { tagIds: Array(201).fill(1) }).total).toBe(0)
  for (const q of [{ page: null }, { pageSize: null }, { tagIds: null }, { ids: null }]) expect(() => listAssets(ctx, q)).toThrow()
})
it('组织相关度与去重：标题、标签、祖先依次排序，同名大小写按id稳定', () => {
  createCategory(ctx, { code: 'parent', name: 'needle' })
  const ancestor = create({ category: 'parent', name: 'alpha' })
  const tagged = create({ tagNames: ['needle', 'needle extra'], name: 'Alpha' })
  const title = create({ name: 'needle' })
  expect(ids({ q: 'needle', searchIn: 'organization' })).toEqual([title.id, tagged.id, ancestor.id])
  expect(listAssets(ctx, { q: 'needle', searchIn: 'organization', pageSize: 1 }).total).toBe(3)
  expect(ids({ sort: 'name' })).toEqual([ancestor.id, tagged.id, title.id])
})
it('FTS Unicode大小写匹配保持字段评分和远端正文高亮', () => {
  const title = create({ name: 'ÄBC' })
  const body = create({ content: '背景'.repeat(200) + 'ÄBC' + '结尾'.repeat(100) })
  expect(ids({ q: 'äbc' })).toEqual([title.id, body.id])
  const excerpt = listAssets(ctx, { q: 'äbc', searchIn: 'body' }).items[0].excerpt!
  expect(excerpt.text).toContain('ÄBC')
  expect(excerpt.matches.map(m => excerpt.text.slice(m.start, m.end))).toEqual(['ÄBC'])
})
it('全文候选不因标签而扩张，已匹配候选仍保留标签60权重', () => {
  const metadata = create({ notes: 'needle' })
  const tagged = create({ content: 'needle', tagNames: ['needle'] })
  create({ tagNames: ['needle'] })
  expect(ids({ q: 'needle' })).toEqual([tagged.id, metadata.id])
})
it('长词字段评分的FTS posting list不随每条候选重复扫描', () => {
  create({ content: 'needle' })
  const plans: Array<{ id: number; parent: number; detail: string }> = []
  const inspected: AssetsContext = { ...ctx, write: operation => ctx.write(s => operation({
    ...s,
    all: (sql, ...params) => {
      if (sql.startsWith('SELECT a.*')) plans.push(...s.all<{ id: number; parent: number; detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params))
      return s.all(sql, ...params)
    }
  })) }
  expect(listAssets(inspected, { q: 'needle' }).total).toBe(1)
  const repeatedFts = plans.filter(row => row.detail.includes('asset_fts') && plans.some(parent => parent.id === row.parent && parent.detail.includes('CORRELATED')))
  expect(repeatedFts).toEqual([])
})
it('稀疏或含undefined的ID数组必须BAD_REQUEST，不能绑定NULL', () => {
  for (const field of ['ids', 'tagIds', 'excludeTagIds']) {
    for (const value of [new Array(1), [undefined], [1, , 2]]) {
      expect(() => listAssets(ctx, { [field]: value })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }))
    }
  }
})
