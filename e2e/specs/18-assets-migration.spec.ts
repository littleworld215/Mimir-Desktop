import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ASSETS_V1_DDL, ASSETS_SCHEMA_VERSION } from '../../electron/assets/schema'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

const runtimes = [
  { name: 'development', executablePath: undefined as string | undefined },
  ...(process.env.MIMIR_E2E_PACKAGED ? [{ name: 'packaged', executablePath: resolve(process.env.MIMIR_E2E_PACKAGED) }] : [])
]

for (const runtime of runtimes) {
  test(`${runtime.name}: real schema1 upgrade preserves old rows and snapshots before searchable schema2`, async () => {
    let oldRows: unknown[] = []
    const launched = await launchApp({
      executablePath: runtime.executablePath,
      transformSeed: seed => {
        const dir = join(seed.workspaces[0]!.path, '.mimir', 'assets')
        mkdirSync(dir, { recursive: true })
        const db = new Database(join(dir, 'assets.db'))
        try {
          for (const ddl of ASSETS_V1_DDL) db.exec(ddl)
          db.exec(`INSERT INTO asset_category(code,name,created_at) VALUES('inbox','旧库自定义分类','2026-01-01');
            INSERT INTO asset(id,code,name,category,storage_type,created_at,updated_at) VALUES(1,'old-asset','旧库原文','inbox','inline_text','2026-01-01','2026-01-01');
            INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(1,1,1,'  真实迁移正文\n\n','2026-01-01');
            UPDATE asset SET current_version_id=1 WHERE id=1;
            PRAGMA user_version=1`)
          oldRows = db.prepare('SELECT * FROM asset_version ORDER BY id').all()
        } finally { db.close() }
        return seed
      }
    })
    try {
      await gotoModule(launched.page, 'assets')
      const oldAsset = launched.page.getByRole('region', { name: '资产列表' }).getByRole('button', { name: /旧库原文/ })
      await expect(oldAsset).toBeVisible()
      await oldAsset.click()
      await expect(launched.page.getByRole('article', { name: '资产详情' })).toContainText('真实迁移正文')
      const dir = join(launched.tempHome.home, 'Mimir', '科研空间', '.mimir', 'assets')
      const reader = new Database(join(dir, 'assets.db'), { readonly: true })
      try {
        expect(reader.pragma('user_version', { simple: true })).toBe(ASSETS_SCHEMA_VERSION)
        expect(reader.pragma('integrity_check', { simple: true })).toBe('ok')
        expect(reader.prepare('SELECT * FROM asset_version ORDER BY id').all()).toEqual(oldRows)
        expect(reader.prepare('SELECT code,name FROM asset_category').all()).toEqual([{ code: 'inbox', name: '旧库自定义分类' }])
        expect(reader.prepare('SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?').all('"迁移正文"')).toEqual([{ rowid: 1 }])
        expect(reader.prepare('SELECT count(*) AS n FROM asset_reference').get()).toEqual({ n: 0 })
      } finally { reader.close() }
      const backups = readdirSync(join(dir, 'backups'))
      expect(backups).toHaveLength(1)
      expect(backups[0]).toMatch(/^schema-1-/)
      const backup = new Database(join(dir, 'backups', backups[0]!), { readonly: true })
      try {
        expect(backup.pragma('user_version', { simple: true })).toBe(1)
        expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
        expect(backup.prepare('SELECT * FROM asset_version ORDER BY id').all()).toEqual(oldRows)
      } finally { backup.close() }
      await launched.page.getByRole('article', { name: '资产详情' }).getByRole('button', { name: '编辑资产' }).click()
      await launched.page.getByLabel('正文', { exact: true }).fill('升级后正文')
      await launched.page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(launched.page.getByRole('article', { name: '资产详情' })).toContainText('升级后正文')
      const after = new Database(join(dir, 'assets.db'), { readonly: true })
      try {
        expect(after.prepare('SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?').all('"迁移正文"')).toEqual([])
        expect(after.prepare('SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?').all('"升级后正文"')).toEqual([{ rowid: 1 }])
        expect(after.prepare('SELECT * FROM asset_version WHERE id=1').get()).toEqual(oldRows[0])
      } finally { after.close() }
    } finally { await launched.cleanup() }
  })
}
