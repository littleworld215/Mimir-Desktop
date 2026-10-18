import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { ASSETS_DDL, ASSETS_SCHEMA_VERSION } from '../../electron/assets/schema'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { seedResearch } from '../fixtures/libraryResearch'
import { launchApp } from '../fixtures/launch'
import { reopenEvidenceApp } from '../fixtures/libraryEvidence'
import { gotoModule } from '../helpers/nav'

function hashes(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  function walk(dir: string) { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) walk(path)
    else if (!/(?:assets\.db-(?:wal|shm)|writer-lock)$/i.test(e.name)) out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
  } }
  walk(root); return out
}
for (const withAssets of [false, true]) test(`研究全历史维护备份恢复、固定引用与重启PDF（${withAssets ? '真实WAL' : '无资产库'}）`, async () => {
  test.setTimeout(180_000)
  let f!: ReturnType<typeof seedResearch>, db: Database.Database | undefined, restarted: Awaited<ReturnType<typeof reopenEvidenceApp>> | undefined
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, extraArgs: ['--workspace-maintenance'], transformSeed: seed => { f = seedResearch(seed); return f.seed } })
  try {
    if (process.env.MIMIR_E2E_PACKAGED) await ctx.app.evaluate((_e, cwd) => process.chdir(cwd), ctx.tempHome.root)
    const dbPath = join(f.root, '.mimir/assets/assets.db')
    if (withAssets) {
      mkdirSync(dirname(dbPath), { recursive: true }); db = new Database(dbPath)
      db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0')
      for (const sql of ASSETS_DDL) db.exec(sql)
      db.pragma(`user_version=${ASSETS_SCHEMA_VERSION}`); db.pragma('wal_checkpoint(TRUNCATE)')
      db.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('research', '科研WAL保留', '2026-10-18')
      expect(readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(0)
    } else expect(existsSync(dbPath)).toBe(false)
    const before = hashes(f.root), wal = withAssets ? readFileSync(`${dbPath}-wal`) : undefined
    const registryPath = join(ctx.tempHome.home, '.mimir/store.json'), registry = JSON.parse(readFileSync(registryPath, 'utf8'))
    const result = await ctx.page.evaluate(async targetRoot => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
      const overview = await api.overview(); if (!overview.ok || !api.backupSpace || !api.restore) throw Error('维护不可用')
      const backup = await api.backupSpace({ spaceId: overview.spaces[0].id }); if (!backup.ok) throw Error(JSON.stringify(backup))
      const latest = await api.overview(); if (!latest.ok || !latest.archives?.length) throw Error('归档不可见')
      return { backup, restored: await api.restore({ archivePath: latest.archives[0].path, targetRoot, spaceName: '恢复研究空间' }), doctor: await api.doctor?.({}) }
    }, join(ctx.tempHome.home, 'Mimir', `恢复研究-${withAssets}`))
    expect(result.backup).toMatchObject({ ok: true, hasAssetsDb: withAssets })
    expect(result.restored, JSON.stringify(result.restored)).toMatchObject({ ok: true })
    const restoredRoot = (result.restored as { root: string }).root
    for (const file of ['research.json', 'evidence.json']) expect(readFileSync(join(restoredRoot, '.mimir/library', file))).toEqual(readFileSync(join(f.root, '.mimir/library', file)))
    expect(hashes(f.root)).toEqual(before); if (wal) expect(readFileSync(`${dbPath}-wal`)).toEqual(wal)
    if (withAssets) {
      const restoredDb = new Database(join(restoredRoot, '.mimir/assets/assets.db'), { readonly: true })
      try { expect(restoredDb.prepare('SELECT name FROM asset_category WHERE code=?').get('research')).toEqual({ name: '科研WAL保留' }) } finally { restoredDb.close() }
    }
    const after = JSON.parse(readFileSync(registryPath, 'utf8'))
    expect(after.activeWorkspaceId).toBe(registry.activeWorkspaceId); expect(after.defaultWorkspaceId).toBe(registry.defaultWorkspaceId)
    expect(after['workspaces:list']).toHaveLength(registry['workspaces:list'].length + 1)
    const newId = after['workspaces:list'].find((s: any) => s.path === restoredRoot).id
    db?.close(); db = undefined
    restarted = await reopenEvidenceApp(ctx)
    expect(await restarted.page.evaluate(id => window.electronAPI!.workspaces.switch(id), newId)).toMatchObject({ ok: true })
    await restarted.page.reload(); await gotoModule(restarted.page, 'library')
    await restarted.page.getByRole('button', { name: '研究问题与写作素材', exact: true }).click()
    await restarted.page.getByRole('button', { name: '写作素材', exact: true }).click()
    await restarted.page.getByRole('button', { name: '打开素材包 恢复基线素材', exact: true }).click()
    await expect(restarted.page.getByLabel('素材包标题', { exact: true })).toHaveValue('恢复基线素材')
    const source = await restarted.page.evaluate(async ({ cardId, packId }) => {
      const api = window.electronAPI!, boot = await api.libraryResearch.overview({}); if (!boot.ok) throw Error(boot.message)
      const detail = await api.libraryResearch.packDetail({ scope: boot.scope, packId })
      const opened = await api.libraryEvidence.openSource({ scope: boot.scope, cardId, version: 2 })
      return { detail, opened }
    }, { cardId: f.cards[0]!.id, packId: f.pack.id })
    expect(source.detail).toMatchObject({ ok: true, items: [{ item: { evidenceVersion: 1 } }, { item: { evidenceVersion: 1 } }] })
    expect(source.opened).toMatchObject({ ok: true, source: { status: 'available', requestedPage: 1 } })
    if (!source.opened.ok) throw Error('PDF不可读')
    const actual = await restarted.app.evaluate(async ({ net }, url) => { const r = await net.fetch(url!); return Array.from(new Uint8Array(await r.arrayBuffer())) }, source.opened.source.pdfUrl)
    expect(Buffer.from(actual)).toEqual(f.pdf)
  } finally { try { db?.close(); await restarted?.app.close() } finally { await ctx.cleanup() } }
})

for (const state of ['missing', 'corrupt', 'newer', 'evidence-missing']) test(`真实维护报告与恢复：研究文件${state}`, async () => {
  test.setTimeout(120_000)
  let f!: ReturnType<typeof seedResearch>
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, extraArgs: ['--workspace-maintenance'], transformSeed: seed => { f = seedResearch(seed); return f.seed } })
  try {
    if (process.env.MIMIR_E2E_PACKAGED) await ctx.app.evaluate((_e, cwd) => process.chdir(cwd), ctx.tempHome.root)
    const path = join(f.root, '.mimir/library/research.json')
    if (state === 'missing' || state === 'evidence-missing') { const { unlinkSync } = await import('node:fs'); unlinkSync(state === 'evidence-missing' ? join(f.root, '.mimir/library/evidence.json') : path) }
    else writeFileSync(path, state === 'newer' ? JSON.stringify({ schemaVersion: 999 }) : '{合成损坏正文')
    const before = hashes(f.root), registryPath = join(ctx.tempHome.home, '.mimir/store.json'), registryBefore = JSON.parse(readFileSync(registryPath, 'utf8'))
    const result = await ctx.page.evaluate(async targetRoot => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
      const overview = await api.overview(); if (!overview.ok || !api.doctor || !api.backupSpace || !api.restore) throw Error('维护不可用')
      const doctor = await api.doctor({}), backup = await api.backupSpace({ spaceId: overview.spaces[0].id })
      const latest = await api.overview(); if (!latest.ok || !latest.archives?.length) throw Error('归档不可见')
      return { doctor, backup, restored: await api.restore({ archivePath: latest.archives[0].path, targetRoot, spaceName: '异常研究恢复' }) }
    }, join(ctx.tempHome.home, 'Mimir', `研究异常-${state}`))
    expect(result.backup).toMatchObject({ ok: true }) // 原字节保全不掩盖业务状态。
    expect(result.doctor.ok).toBe(true)
    if (!result.doctor.ok) throw Error('自检失败')
    const check = result.doctor.checks.find(c => c.id === 'RESEARCH_INTEGRITY')
    expect(check?.severity).toBe(state === 'missing' ? 'notice' : state === 'evidence-missing' ? 'warning' : 'error')
    expect(JSON.stringify(result.doctor)).not.toContain('合成损坏正文')
    expect(JSON.stringify(result.doctor)).not.toContain(f.root)
    if (state === 'evidence-missing') expect(check?.detail).toContain('证据文件缺失（EVIDENCE_MISSING）')
    expect(result.restored.ok).toBe(state === 'missing' || state === 'evidence-missing')
    if (state !== 'missing' && state !== 'evidence-missing') {
      expect(result.restored).toMatchObject({ ok: false, code: 'RECHECK_FAILED' })
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual(registryBefore)
    }
    expect(hashes(f.root)).toEqual(before)
  } finally { await ctx.cleanup() }
})
