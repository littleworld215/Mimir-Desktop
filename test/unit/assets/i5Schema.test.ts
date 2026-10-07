import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, it, expect } from 'vitest'
import { ASSETS_V2_DDL, ASSETS_I4_DDL } from '../../../electron/assets/schema'
import { assetsLayout } from '../../../electron/assets/paths'
import { openAssetsStore } from '../../../electron/assets/store'
import { initializeSchema } from '../../../electron/assets/migrations'
let root: string
const connections: Database.Database[] = []
const factory = (p: string, o: Database.Options) => new Database(p, o)
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'assets-i5-schema-')) })
afterEach(() => { for (const db of connections.splice(0)) if (db.open) db.close(); rmSync(root, { recursive: true, force: true }) })
function old() {
  const layout = assetsLayout(root); mkdirSync(layout.root, { recursive: true })
  const db = factory(layout.dbPath, {}); connections.push(db)
  for (const ddl of [...ASSETS_V2_DDL, ...ASSETS_I4_DDL]) db.exec(ddl)
  db.exec("INSERT INTO asset_category(code,name,created_at) VALUES ('inbox','原分类','now'); INSERT INTO asset(code,name,category,storage_type,created_at,updated_at) VALUES ('a','原文','inbox','inline_text','now','now'); INSERT INTO asset_version(asset_id,version,content,created_at) VALUES (1,1,' 空白\r\n','now'); UPDATE asset SET current_version_id=1; INSERT INTO saved_filter(name,query_json,created_at,updated_at) VALUES ('原筛选','{}','now','now'); PRAGMA user_version=3")
  return { layout, db }
}
it('schema3备份后升级4，原文/筛选/FTS逐行不变，重开不重复备份', async () => {
  const { layout, db } = old(), tables = ['asset', 'asset_version', 'saved_filter', 'asset_fts']
  const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()); db.close()
  const store = await openAssetsStore({ root, databaseFactory: factory })
  try {
    expect(store.db.pragma('user_version', { simple: true })).toBe(4)
    expect(tables.map(t => store.db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before)
    expect(store.db.prepare('SELECT * FROM ai_draft').all()).toEqual([])
  } finally { store.close() }
  const backups = readdirSync(layout.backupsDir); expect(backups).toHaveLength(1)
  const snap = factory(join(layout.backupsDir, backups[0]), { readonly: true })
  try { expect(snap.pragma('user_version', { simple: true })).toBe(3); expect(tables.map(t => snap.prepare(`SELECT * FROM ${t}`).all())).toEqual(before) } finally { snap.close() }
  const reopen = await openAssetsStore({ root, databaseFactory: factory }); reopen.close()
  expect(readdirSync(layout.backupsDir)).toEqual(backups)
})
it('schema3漂移拒绝迁移；新DDL故障全部回滚不产生半张草稿表', async () => {
  const { db } = old(), exec = db.exec.bind(db)
  db.exec = ((sql: string) => { if (sql.includes('idx_ai_draft')) throw Error('DDL fault'); return exec(sql) }) as typeof db.exec
  expect(() => initializeSchema(db, () => new Date())).toThrow('DDL fault')
  expect(db.pragma('user_version', { simple: true })).toBe(3)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='ai_draft'").get()).toBeUndefined()
  db.exec = exec; db.exec('DROP INDEX idx_saved_filter_updated'); db.close()
  await expect(openAssetsStore({ root, databaseFactory: factory })).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
})
