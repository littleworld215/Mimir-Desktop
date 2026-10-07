import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ASSETS_V3_DDL } from '../../electron/assets/schema'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('real Electron schema3 -> 4 preserves original/filter/FTS and immutable snapshot without model calls', async () => {
  let dir = '', before: unknown[] = []
  const tables = ['asset', 'asset_version', 'saved_filter', 'asset_fts']
  const launched = await launchApp({ transformSeed: seed => {
    dir = join(seed.workspaces[0]!.path, '.mimir', 'assets'); mkdirSync(dir, { recursive: true })
    const db = new Database(join(dir, 'assets.db'))
    try {
      for (const ddl of ASSETS_V3_DDL) db.exec(ddl)
      db.exec("INSERT INTO asset_category(code,name,created_at) VALUES ('inbox','原分类','now'); INSERT INTO asset(code,name,category,storage_type,created_at,updated_at) VALUES ('old','AI整合旧原文','inbox','inline_text','now','now'); INSERT INTO asset_version(asset_id,version,content,created_at) VALUES (1,1,' 原文\r\n\n','now'); UPDATE asset SET current_version_id=1; INSERT INTO saved_filter(name,query_json,created_at,updated_at) VALUES ('原筛选','{}','now','now'); PRAGMA user_version=3")
      before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())
    } finally { db.close() }
    return seed
  } })
  try {
    await gotoModule(launched.page, 'assets')
    await expect(launched.page.getByRole('button', { name: /AI整合旧原文/ })).toBeVisible()
    await launched.app.close()
    const db = new Database(join(dir, 'assets.db'), { readonly: true })
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(4)
      expect(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before)
      expect(db.prepare('SELECT * FROM ai_draft').all()).toEqual([])
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally { db.close() }
    const backups = readdirSync(join(dir, 'backups')); expect(backups).toHaveLength(1)
    const snap = new Database(join(dir, 'backups', backups[0]), { readonly: true })
    try {
      expect(snap.pragma('user_version', { simple: true })).toBe(3)
      expect(tables.map(t => snap.prepare(`SELECT * FROM ${t}`).all())).toEqual(before)
    } finally { snap.close() }
  } finally { await launched.cleanup() }
})
