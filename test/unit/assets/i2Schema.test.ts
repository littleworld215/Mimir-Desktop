import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as schema from '../../../electron/assets/schema'
import { openAssetsStore } from '../../../electron/assets/store'
import { assetsLayout } from '../../../electron/assets/paths'
import type { AssetsStore, DatabaseFactory } from '../../../electron/assets/types'

const factory: DatabaseFactory = (path, options) => new Database(path, options)
let root: string
const stores: AssetsStore[] = []
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mimir-i2-schema-')) })
afterEach(() => { stores.splice(0).forEach(store => store.close()); rmSync(root, { recursive: true, force: true }) })
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
async function open(options: Partial<Parameters<typeof openAssetsStore>[0]> = {}) {
  const store = await openAssetsStore({ root, databaseFactory: factory, ...options })
  stores.push(store)
  return store
}
function legacy() {
  const layout = assetsLayout(root)
  mkdirSync(layout.root, { recursive: true })
  const db = factory(layout.dbPath, {})
  const oldDdl = (schema as unknown as { ASSETS_V1_DDL?: readonly string[] }).ASSETS_V1_DDL ?? schema.ASSETS_DDL
  for (const ddl of oldDdl) db.exec(ddl)
  db.exec(`INSERT INTO asset_category(code,name,created_at) VALUES('inbox','用户改名','2026-01-01'),('custom','自建分类','2026-01-01');
    INSERT INTO asset(id,code,name,category,description,notes,source_task,storage_type,created_at,updated_at)
      VALUES(1,'a','科研标题','inbox','科研摘要','科研备注','科研来源','inline_text','2026-01-01','2026-01-01'),
      (2,'b','外链','custom','','','','external_link','2026-01-01','2026-01-01'),
      (3,'c','文件空壳','custom','','','','file','2026-01-01','2026-01-01');
    INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(1,1,1,'旧版独有词','2026-01-01'),(2,1,2,'当前全文数据','2026-01-02'),(3,2,1,'','2026-01-01');
    UPDATE asset SET current_version_id=2 WHERE id=1;
    UPDATE asset SET current_version_id=3,external_url='https://example.com' WHERE id=2;
    INSERT INTO tag(id,name,normalized_name) VALUES(1,'旧标签','旧标签');
    INSERT INTO asset_tag(asset_id,tag_id) VALUES(1,1);
    PRAGMA user_version=1`)
  db.close()
  return layout
}
function business(db: Database.Database) {
  return ['asset_category', 'asset', 'asset_version', 'tag', 'asset_tag'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())
}
const match = (db: Database.Database, word: string) => db.prepare('SELECT rowid FROM asset_fts WHERE asset_fts MATCH ? ORDER BY rowid').all(`"${word}"`)

describe('I2 schema2 migration and transactional index', () => {
  it('new store has schema2, empty index/references and 15 categories, without an empty backup', async () => {
    const store = await open()
    expect(store.db.pragma('user_version', { simple: true })).toBe(schema.ASSETS_SCHEMA_VERSION)
    expect(store.db.prepare('SELECT count(*) AS n FROM asset_fts').get()).toEqual({ n: 0 })
    expect(store.db.prepare('SELECT count(*) AS n FROM asset_reference').get()).toEqual({ n: 0 })
    expect(store.db.prepare('SELECT count(*) AS n FROM asset_category').get()).toEqual({ n: 15 })
    expect(readdirSync(store.layout.backupsDir)).toHaveLength(0)
  })
  it('backs up known schema1, keeps every old business row, backfills only current versions and does not reseed', async () => {
    const layout = legacy()
    const reader = factory(layout.dbPath, { readonly: true })
    const before = business(reader)
    reader.close()
    const store = await open()
    expect(store.db.pragma('user_version', { simple: true })).toBe(schema.ASSETS_SCHEMA_VERSION)
    expect(business(store.db)).toEqual(before)
    for (const word of ['科研标题', '科研摘要', '科研备注', '科研来源', '当前全文']) expect(match(store.db, word)).toEqual([{ rowid: 1 }])
    expect(match(store.db, '旧版独有')).toEqual([])
    expect(store.db.prepare('SELECT count(*) AS n FROM asset_fts').get()).toEqual({ n: 3 })
    const snapshots = readdirSync(layout.backupsDir)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatch(/^schema-1-/)
    const backup = factory(join(layout.backupsDir, snapshots[0]!), { readonly: true })
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(1)
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(business(backup)).toEqual(before)
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='asset_fts'").get()).toBeUndefined()
    } finally { backup.close() }
    store.close()
    expect(business((await open()).db)).toEqual(before)
    expect(readdirSync(layout.backupsDir)).toEqual(snapshots)
  })
  it('backup failure preserves original hash/schema/data and releases the writer for a later retry', async () => {
    const layout = legacy()
    const before = hash(layout.dbPath)
    await expect(open({ snapshot: async () => { throw new Error('snapshot denied') } })).rejects.toThrow('snapshot denied')
    expect(hash(layout.dbPath)).toBe(before)
    expect((await open()).db.pragma('user_version', { simple: true })).toBe(schema.ASSETS_SCHEMA_VERSION)
  })
  it('DDL failure rolls back the entire migration while retaining the immutable schema1 backup', async () => {
    const layout = legacy()
    const before = hash(layout.dbPath)
    const failing: DatabaseFactory = (path, options) => {
      const db = factory(path, options)
      if (path === layout.dbPath && !options.readonly) {
        const exec = db.exec.bind(db)
        db.exec = sql => { if (sql.includes('VIRTUAL TABLE')) throw new Error('forced FTS failure'); return exec(sql) }
      }
      return db
    }
    await expect(open({ databaseFactory: failing })).rejects.toThrow('forced FTS failure')
    expect(hash(layout.dbPath)).toBe(before)
    const reader = factory(layout.dbPath, { readonly: true })
    try {
      expect(reader.pragma('user_version', { simple: true })).toBe(1)
      expect(reader.prepare("SELECT name FROM sqlite_master WHERE name='asset_reference'").get()).toBeUndefined()
    } finally { reader.close() }
    expect(readdirSync(layout.backupsDir)).toHaveLength(1)
    expect((await open()).db.pragma('user_version', { simple: true })).toBe(schema.ASSETS_SCHEMA_VERSION)
  })
  it('rejects drifted schema1 before backup or any writable open', async () => {
    const layout = legacy()
    const db = factory(layout.dbPath, {})
    db.exec('DROP TRIGGER trg_asset_version_no_update')
    db.close()
    const before = hash(layout.dbPath)
    let writes = 0
    await expect(open({ databaseFactory: (path, options) => { if (path === layout.dbPath && !options.readonly) writes++; return factory(path, options) } })).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
    expect(writes).toBe(0)
    expect(hash(layout.dbPath)).toBe(before)
  })
  it('backfill failure rolls back already-created reference/FTS schema and leaves the old database unchanged', async () => {
    const layout = legacy()
    const before = hash(layout.dbPath)
    const failing: DatabaseFactory = (path, options) => {
      const db = factory(path, options)
      if (path === layout.dbPath && !options.readonly) {
        const exec = db.exec.bind(db)
        db.exec = sql => { if (/^\s*INSERT INTO asset_fts\(rowid,name/.test(sql)) throw new Error('forced backfill failure'); return exec(sql) }
      }
      return db
    }
    await expect(open({ databaseFactory: failing })).rejects.toThrow('forced backfill failure')
    expect(hash(layout.dbPath)).toBe(before)
    const reader = factory(layout.dbPath, { readonly: true })
    try {
      expect(reader.pragma('user_version', { simple: true })).toBe(1)
      expect(reader.prepare("SELECT name FROM sqlite_master WHERE name IN ('asset_fts','asset_reference')").all()).toEqual([])
    } finally { reader.close() }
    expect(readdirSync(layout.backupsDir)).toHaveLength(1)
    expect((await open()).db.pragma('user_version', { simple: true })).toBe(schema.ASSETS_SCHEMA_VERSION)
  })
  it('schema1 snapshot includes committed uncheckpointed WAL rows instead of copying only the main file', async () => {
    const layout = legacy()
    const writer = factory(layout.dbPath, {})
    writer.pragma('journal_mode = WAL')
    writer.pragma('wal_autocheckpoint = 0')
    // A readonly snapshot holds the old end mark, keeping the subsequent committed
    // WAL frames alive even when the original writer closes before migration.
    const pinned = factory(layout.dbPath, { readonly: true })
    pinned.exec('BEGIN')
    pinned.prepare('SELECT count(*) FROM asset').get()
    try {
      writer.exec("UPDATE asset SET name='仅WAL中的标题' WHERE id=1; INSERT INTO asset_version(asset_id,version,content,created_at) VALUES(1,3,'仅WAL中的正文','2026-01-03'); UPDATE asset SET current_version_id=last_insert_rowid() WHERE id=1")
      const before = business(writer)
      writer.close()
      expect(existsSync(`${layout.dbPath}-wal`)).toBe(true)
      expect(statSync(`${layout.dbPath}-wal`).size).toBeGreaterThan(0)
      const store = await open()
      expect(business(store.db)).toEqual(before)
      expect(match(store.db, '仅WAL中的正文')).toEqual([{ rowid: 1 }])
      const snapshots = readdirSync(layout.backupsDir)
      expect(snapshots).toHaveLength(1)
      const backup = factory(join(layout.backupsDir, snapshots[0]!), { readonly: true })
      try {
        expect(backup.pragma('user_version', { simple: true })).toBe(1)
        expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
        expect(business(backup)).toEqual(before)
      } finally { backup.close() }
    } finally { if (writer.open) writer.close(); pinned.close() }
  })
  it('index follows metadata, clearing/current pointer, explicit rollback and delete without touching historical content', async () => {
    legacy()
    const { db } = await open()
    db.exec("UPDATE asset SET name='更新标题',notes='新备注内容',source_task='新来源任务',description='新摘要内容' WHERE id=1")
    expect(match(db, '科研标题')).toEqual([])
    for (const word of ['更新标题', '新备注', '新来源', '新摘要']) expect(match(db, word)).toEqual([{ rowid: 1 }])
    db.exec("INSERT INTO asset_version(asset_id,version,content,created_at) VALUES(1,3,'','2026-01-03'); UPDATE asset SET current_version_id=last_insert_rowid() WHERE id=1")
    expect(match(db, '当前全文')).toEqual([])
    db.exec("INSERT INTO asset_version(asset_id,version,content,created_at) VALUES(1,4,'旧版独有词','2026-01-04'); UPDATE asset SET current_version_id=last_insert_rowid() WHERE id=1")
    expect(match(db, '旧版独有')).toEqual([{ rowid: 1 }])
    expect(() => db.exec("UPDATE asset_version SET content='bad' WHERE id=1")).toThrow('append-only')
    db.exec('UPDATE asset SET current_version_id=NULL WHERE id=1; DELETE FROM asset WHERE id=1')
    expect(match(db, '更新标题')).toEqual([])
    expect(db.prepare('SELECT rowid FROM asset_fts WHERE rowid=1').get()).toBeUndefined()
  })
  it('failed metadata/version transaction restores index and business state atomically', async () => {
    legacy()
    const { db } = await open()
    const before = business(db)
    expect(() => db.transaction(() => {
      db.exec("UPDATE asset SET name='失败标题' WHERE id=1; INSERT INTO asset_version(asset_id,version,content,created_at) VALUES(1,3,'失败正文','2026-01-03'); UPDATE asset SET current_version_id=last_insert_rowid() WHERE id=1")
      expect(match(db, '失败正文')).toEqual([{ rowid: 1 }])
      throw new Error('abort')
    })()).toThrow('abort')
    expect(business(db)).toEqual(before)
    expect(match(db, '失败正文')).toEqual([])
    expect(match(db, '科研标题')).toEqual([{ rowid: 1 }])
  })
  it('reference constraints deduplicate, forbid self/missing targets and cascade both directions without deleting other assets', async () => {
    legacy()
    const { db } = await open()
    db.exec("INSERT INTO asset_reference(source_asset_id,target_asset_id,created_at) VALUES(1,2,'2026-01-01'),(2,1,'2026-01-01'),(3,1,'2026-01-01')")
    expect(() => db.exec("INSERT INTO asset_reference VALUES(1,2,'2026-01-02')")).toThrow()
    expect(() => db.exec("INSERT INTO asset_reference VALUES(1,1,'2026-01-02')")).toThrow()
    expect(() => db.exec("INSERT INTO asset_reference VALUES(1,999,'2026-01-02')")).toThrow()
    db.exec('UPDATE asset SET current_version_id=NULL WHERE id=1; DELETE FROM asset WHERE id=1')
    expect(db.prepare('SELECT count(*) AS n FROM asset_reference').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT id FROM asset ORDER BY id').all()).toEqual([{ id: 2 }, { id: 3 }])
  })
  it('missing schema2 index trigger is refused on reopen instead of repairing and silently rebuilding', async () => {
    const store = await open()
    store.db.exec('DROP TRIGGER trg_asset_fts_update')
    store.close()
    await expect(open()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
  })
})
