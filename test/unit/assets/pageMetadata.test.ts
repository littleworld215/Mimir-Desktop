import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext, AssetsWriteSession } from '../../../electron/assets/types'
import { summary, type AssetRow } from '../../../electron/assets/assetRepository'
import { listAssets } from '../../../electron/assets/assetService'

let root: string
let manager: AssetsStoreManager
let ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-page-metadata-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
  ctx.write(s => {
    s.run("INSERT INTO asset_category(code,name,parent_code,created_at) VALUES('parent','Parent',NULL,'now'),('leaf','Leaf','parent','now'),('other','Other','parent','now'),('unused','Unused',NULL,'now')")
    s.run("INSERT INTO tag(id,name,normalized_name,color,revision) VALUES(1,'z tag','z tag','#fff',3),(2,'a tag','a tag',NULL,2)")
    for (let id = 1; id <= 200; id++) {
      s.run("INSERT INTO asset(id,code,name,category,storage_type,description,notes,source_task,is_favorite,last_used_at,created_at,updated_at) VALUES(?,?,?,?,'inline_text',?,?,?,1,?,'now',?)",
        id, 'page-'+id, 'Asset '+id, id % 2 ? 'leaf' : 'other', 'desc 科研', 'notes', 'source scientific', '2026-10-28', '2026-10-'+String(id % 28 + 1).padStart(2,'0'))
      s.run("INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(?,?,2,'科研 scientific 🧪😀🔬','now')", id, id)
      s.run('UPDATE asset SET current_version_id=? WHERE id=?', id, id)
      s.run('INSERT INTO asset_tag(asset_id,tag_id) VALUES(?,2),(?,1)', id, id)
    }
  })
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })

function observe() {
  const reads: Array<{ sql: string; args: unknown[] }> = []
  const wrapped: AssetsContext = { ...ctx, write: operation => ctx.write(s => {
    const session: AssetsWriteSession = {
      run: (sql, ...args) => s.run(sql, ...args),
      get: (sql, ...args) => { reads.push({ sql, args }); return s.get(sql, ...args) },
      all: (sql, ...args) => { reads.push({ sql, args }); return s.all(sql, ...args) }
    }
    return operation(session)
  }) }
  return { reads, wrapped }
}

it.each([50, 200])('pageSize=%i：只批量读取本页版本标签及分类，查询不随条数增长', pageSize => {
  const { reads, wrapped } = observe()
  const result = listAssets(wrapped, { pageSize })
  expect(result.items).toHaveLength(pageSize)
  // count + page + current versions + tags + required category ancestor closure
  expect(reads).toHaveLength(5)
  expect(reads.filter(r => /FROM asset_version/.test(r.sql))).toHaveLength(1)
  expect(reads.filter(r => /FROM tag/.test(r.sql))).toHaveLength(1)
  expect(reads.every(r => !/SELECT content|SELECT \*/.test(r.sql))).toBe(true)
})

it('每条DTO逐字等于旧summary，保持标签顺序、路径和所有字段', () => {
  const result = listAssets(ctx, { pageSize: 50 })
  const old = ctx.write(s => result.items.map(item => summary(s, s.get<AssetRow>('SELECT * FROM asset WHERE id=?', item.id)!)))
  expect(JSON.stringify(result.items)).toBe(JSON.stringify(old))
  expect(result.items[0].tags.map(t => t.id)).toEqual([1, 2])
  result.items[0].tags[0].name = 'mutated'
  result.items[0].categoryPath[0] = 'mutated'
  expect(result.items[1].tags[0].name).toBe('z tag')
  expect(result.items[1].categoryPath[0]).toBe('Parent')
})

it('空页只查询数量和分页，不载入任何关联', () => {
  const { reads, wrapped } = observe()
  expect(listAssets(wrapped, { page: 99 }).items).toEqual([])
  expect(reads).toHaveLength(2)
})

it('无版本无标签的单层分类仍保持空值，只发出所需四条读取', () => {
  ctx.write(s => {
    s.run("UPDATE asset SET current_version_id=NULL,category='inbox'")
    s.run('DELETE FROM asset_tag')
  })
  const { reads, wrapped } = observe()
  const page = listAssets(wrapped, { pageSize: 50 })
  expect(reads).toHaveLength(4)
  expect(page.items.every(item => item.currentVersion === null && item.tags.length === 0)).toBe(true)
})

it('当前页之外的历史正文、版本和标签不进入批量读取', () => {
  const { reads, wrapped } = observe()
  const page = listAssets(wrapped, { page: 2, pageSize: 3, sort: 'name' })
  const ids = new Set(page.items.map(i => i.id))
  for (const read of reads.filter(r => /FROM asset_version|FROM tag/.test(r.sql))) {
    expect(read.args.length).toBe(3)
    expect(read.args.every(id => ids.has(id as number))).toBe(true)
    expect(read.sql).not.toMatch(/content/)
  }
})

it('null、丢失及指向其他资产的版本保持null', () => {
  ctx.write(s => s.run('UPDATE asset SET current_version_id=NULL WHERE id=1'))
  // Corrupt pointers are metadata controls; do not weaken real SQLite constraints.
  const corrupt: AssetsContext = { ...ctx, write: operation => ctx.write(s => operation({
    run: (sql, ...args) => s.run(sql, ...args),
    get: (sql, ...args) => s.get(sql, ...args),
    all: <T>(sql: string, ...args: unknown[]) => s.all<T>(sql, ...args).map(value => {
      if (!sql.startsWith('SELECT a.*')) return value
      const row = value as AssetRow
      return { ...row, current_version_id: row.id === 3 ? 2 : row.id === 4 ? 999999 : row.current_version_id } as T
    })
  })) }
  const result = listAssets(corrupt, { ids: [1, 2, 3, 4] })
  expect(result.items.map(i => [i.id, i.currentVersion]).sort((a,b) => Number(a[0])-Number(b[0]))).toEqual([[1,null],[2,2],[3,null],[4,null]])
})

it.each(['missing', 'cycle'])('损坏分类%s保留原错误码和文本', variant => {
  const { wrapped } = observe()
  const bad: AssetsContext = { ...wrapped, write: operation => wrapped.write(s => {
    const patch = <T>(rows: T[]) => rows.map(value => {
      const row = value as { code?: string; parent_code?: string | null }
      return row.code === 'leaf' ? { ...row, parent_code: variant === 'missing' ? 'not-found' : 'leaf' } as T : value
    })
    return operation({
      run: (sql, ...args) => s.run(sql, ...args),
      get: (sql, ...args) => { const row = s.get(sql, ...args); return row ? patch([row])[0] : row },
      all: (sql, ...args) => patch(s.all(sql, ...args))
    })
  }) }
  expect(() => listAssets(bad, { ids: [1] })).toThrow(expect.objectContaining({
    code: variant === 'missing' ? 'BAD_CATEGORY' : 'CYCLE',
    message: variant === 'missing' ? '资产分类不存在。' : '分类路径存在循环。'
  }))
})

it('缓存不跨请求，下一事务立即看到分类标签及版本更新', () => {
  listAssets(ctx)
  ctx.write(s => {
    s.run("UPDATE asset_category SET name='Renamed' WHERE code='parent'")
    s.run("UPDATE tag SET name='Updated' WHERE id=1")
    s.run("INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(201,1,3,'new body','now')")
    s.run('UPDATE asset SET current_version_id=201 WHERE id=1')
  })
  const item = listAssets(ctx, { ids: [1] }).items[0]
  expect(item.categoryPath).toEqual(['Renamed','Leaf'])
  expect(item.tags[0].name).toBe('Updated')
  expect(item.currentVersion).toBe(3)
})

it('仍使用受守卫会话，读取期间失效立即拒绝并不回退到缓存', () => {
  let reads = 0
  const stale: AssetsContext = { ...ctx, write: operation => ctx.write(s => operation({
    run: (sql, ...args) => s.run(sql, ...args),
    get: (sql, ...args) => { if (++reads === 4) throw Error('SPACE_CHANGED'); return s.get(sql, ...args) },
    all: (sql, ...args) => { if (++reads === 4) throw Error('SPACE_CHANGED'); return s.all(sql, ...args) }
  })) }
  expect(() => listAssets(stale)).toThrow('SPACE_CHANGED')
})

it('相同分类码和资产ID在第二个空间独立解析，不复用前一空间结果', async () => {
  listAssets(ctx)
  const otherRoot = mkdtempSync(join(tmpdir(), 'assets-page-other-'))
  const otherManager = new AssetsStoreManager({ active: () => ({ id: 'B', path: otherRoot }), epoch: () => 'B#1' }, (p,o) => new Database(p,o))
  try {
    const other = await otherManager.getForRequest(otherManager.context())
    other.write(s => {
      s.run("INSERT INTO asset_category(code,name,created_at) VALUES('leaf','Other space','now')")
      s.run("INSERT INTO asset(id,code,name,category,storage_type,created_at,updated_at) VALUES(1,'other','Other','leaf','inline_text','now','now')")
    })
    const item = listAssets(other).items[0]
    expect(item.categoryPath).toEqual(['Other space'])
    expect(item.tags).toEqual([])
    expect(item.currentVersion).toBe(null)
  } finally { await otherManager.close(); rmSync(otherRoot, { recursive: true, force: true }) }
})
