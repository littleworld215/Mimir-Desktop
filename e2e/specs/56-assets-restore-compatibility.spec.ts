import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { ASSETS_DDL, ASSETS_V1_DDL, ASSETS_V2_DDL, ASSETS_V3_DDL } from '../../electron/assets/schema'
import { createBackup } from '../../electron/workspaceBackup/packer'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { launchApp } from '../fixtures/launch'

function hashes(root: string) {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(root)
  return files
}

for (const scenario of [0, 1, 2, 3, 4, 'future', 'missing-history', 'invalid-owner', 'schema-drift', 'literal-drift'] as const) {
  test(`真实维护恢复资产库 ${scenario}：版本/历史附件与源资料保护`, async () => {
    let sourceRoot = ''
    const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED,
      maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true, extraArgs: ['--workspace-maintenance'], transformSeed: seed => { sourceRoot = seed.workspaces[0].path; return seed }
    })
    try {
      if (process.env.MIMIR_E2E_PACKAGED) await ctx.app.evaluate((_electron, cwd) => process.chdir(cwd), ctx.tempHome.root)
      const version = typeof scenario === 'number' ? scenario : scenario === 'future' ? 5 : 4
      const dbPath = join(sourceRoot, '.mimir/assets/assets.db')
      mkdirSync(dirname(dbPath), { recursive: true })
      const db = new Database(dbPath)
      try {
        if (version !== 0) {
          for (const ddl of version === 1 ? ASSETS_V1_DDL : version === 2 ? ASSETS_V2_DDL : version === 3 ? ASSETS_V3_DDL : ASSETS_DDL) {
            db.exec(scenario === 'literal-drift' ? ddl.replaceAll("'pending'", "'PENDING'") : ddl)
          }
          db.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('inbox', '未分类', '2026-10-24')
          db.prepare('INSERT INTO asset(id,code,name,category,storage_type,archived_at,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)')
            .run('history', '归档资产', 'inbox', 'file', '2026-10-24', '2026-10-24', '2026-10-24')
          db.prepare('INSERT INTO asset_version(id,asset_id,version,file_path,content,created_at) VALUES(1,1,1,?,?,?)')
            .run(scenario === 'invalid-owner' ? 'files/2/历史😀.txt' : 'files/1/历史😀.txt', '旧版本\n\n', '2026-10-24')
          db.prepare('INSERT INTO asset_version(id,asset_id,version,file_path,content,created_at) VALUES(2,1,2,?,?,?)')
            .run('files/1/当前.txt', '当前\n', '2026-10-24')
          db.exec('UPDATE asset SET current_version_id=2 WHERE id=1')
        }
        db.pragma(`user_version=${version}`)
        if (scenario === 'schema-drift') db.exec('CREATE TABLE unknown_business(value TEXT)')
      } finally { db.close() }
      mkdirSync(join(dirname(dbPath), 'files/1'), { recursive: true })
      if (scenario !== 'missing-history') writeFileSync(join(dirname(dbPath), 'files/1/历史😀.txt'), '历史字节\n\n')
      writeFileSync(join(dirname(dbPath), 'files/1/当前.txt'), '当前字节')
      const before = hashes(sourceRoot)
      const archives = join(ctx.tempHome.home, 'backups')
      mkdirSync(archives, { recursive: true })
      const archivePath = join(archives, 'mimir-backup-compatibility-20261024-000001.zip')
      const snapshotDb = new Database(dbPath, { readonly: true })
      try { await createBackup({ root: sourceRoot, destination: archivePath, stagingDir: join(ctx.tempHome.root, 'packing'), assetsDb: snapshotDb, assetsDbRelPath: '.mimir/assets/assets.db' }) }
      finally { snapshotDb.close() }
      const archiveBefore = readFileSync(archivePath)
      const registry = join(ctx.tempHome.home, '.mimir/store.json')
      const registryBefore = readFileSync(registry)
      const doctor = await ctx.page.evaluate(async () => {
        const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
        if (!api.doctor) throw Error('No doctor entry')
        return api.doctor()
      })
      expect(doctor.ok).toBe(true)
      if (!doctor.ok) throw Error(JSON.stringify(doctor))
      const bad = typeof scenario !== 'number'
      expect(doctor.checks.find(check => check.id === 'SPACE_INTEGRITY')?.severity).toBe(bad ? 'warning' : 'ok')
      // 自检绝不能提前迁移源旧库。
      expect(hashes(sourceRoot)).toEqual(before)
      const targetRoot = join(dirname(sourceRoot), `恢复-${scenario}`)
      const result = await ctx.page.evaluate(async request => {
        const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
        if (!api.restore) throw Error('No restore entry')
        return api.restore(request)
      }, { archivePath, targetRoot, spaceName: `恢复-${scenario}` })
      if (bad) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: scenario === 'future' ? 'VERSION_UNSUPPORTED' : 'INTEGRITY_FAILED' })
        expect(existsSync(targetRoot)).toBe(false)
        expect(readFileSync(registry)).toEqual(registryBefore)
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
        const restored = new Database(join(targetRoot, '.mimir/assets/assets.db'), { readonly: true })
        try {
          expect(restored.pragma('user_version', { simple: true })).toBe(4)
          if (version !== 0) expect(restored.prepare('SELECT content FROM asset_version ORDER BY id').all()).toEqual([{ content: '旧版本\n\n' }, { content: '当前\n' }])
        } finally { restored.close() }
        if (version < 4) {
          const backupDir = join(targetRoot, '.mimir/assets/backups')
          const names = readdirSync(backupDir).filter(name => name.endsWith('.db'))
          expect(names).toHaveLength(1)
          const old = new Database(join(backupDir, names[0]), { readonly: true })
          try { expect(old.pragma('user_version', { simple: true })).toBe(version) } finally { old.close() }
        }
        expect(readFileSync(join(targetRoot, '.mimir/assets/files/1/历史😀.txt'), 'utf8')).toBe('历史字节\n\n')
        const previous = JSON.parse(registryBefore.toString()), next = JSON.parse(readFileSync(registry, 'utf8'))
        expect(next['workspaces:list']).toHaveLength(previous['workspaces:list'].length + 1)
        expect(next.activeWorkspaceId).toEqual(previous.activeWorkspaceId)
      }
      expect(hashes(sourceRoot)).toEqual(before)
      expect(readFileSync(archivePath)).toEqual(archiveBefore)
    } finally { await ctx.cleanup() }
  })
}
