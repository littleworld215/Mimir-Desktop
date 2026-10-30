import { test, expect, type ElectronApplication } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { ASSETS_DDL, ASSETS_SCHEMA_VERSION } from '../../electron/assets/schema'
import { archiveEvidence, createEvidence, reviseEvidence, updateEvidence, type EvidenceContext } from '../../electron/library/evidence/service'
import type { PaperRecord, ProjectRecord } from '../../electron/library/types'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { launchApp } from '../fixtures/launch'
import { evidencePdf, reopenEvidenceApp } from '../fixtures/libraryEvidence'
import { gotoModule } from '../helpers/nav'

// 测试夹具只计算规范文件名，不加载 arxiv/http 的 Electron 运行依赖。
const paperPdfFileName = (id: string) => `${encodeURIComponent(id)}.pdf`

function hashes(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (!/(?:assets\.db-(?:wal|shm)|writer-lock)$/i.test(entry.name)) result[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(root)
  return result
}

for (const withAssets of [false, true]) test(`证据全历史真实备份恢复及重启 PDF（${withAssets ? '真实WAL' : '无资产库'}）`, async () => {
  test.setTimeout(180_000)
  let root = '', workspaceId = ''
  const id = 'doi:10.1/恢复证据😀', title = '恢复后的合成证据'
  let paper: PaperRecord, project: ProjectRecord
  let db: Database.Database | undefined, restarted: ElectronApplication | undefined
  // Only this isolated fixture explicitly accepts its own native-picker suggestions and scope preview.
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true, extraArgs: ['--workspace-maintenance'], transformSeed: seed => {
    root = seed.workspaces[0].path; workspaceId = seed.workspaces[0].id
    paper = { arxivId: id, title, authors: ['合成作者'], summary: '离线资料', url: 'https://example.org/synthetic', notes: '旧笔记完整保留', tags: [], projectIds: ['restore-project'], addedAt: '2026-10-17', pdfPath: join(root, 'papers', paperPdfFileName(id)) }
    project = { id: 'restore-project', title: '恢复课题', createdAt: '2026-10-17', updatedAt: '2026-10-17' }
    return { ...seed, spaceData: { 'library:papers': { [id]: paper }, 'library:projects': [project] } }
  } })
  try {
    if (process.env.MIMIR_E2E_PACKAGED) await ctx.app.evaluate((_e, cwd) => process.chdir(cwd), ctx.tempHome.root)
    mkdirSync(dirname(paper!.pdfPath!), { recursive: true })
    const pdf = evidencePdf()
    writeFileSync(paper!.pdfPath!, pdf)
    // 仅构造隔离源资料；被测备份、恢复、核对、协议均走实际 Electron 生产入口。
    const scope: EvidenceContext = { scope: { id: workspaceId, epoch: 'fixture', root }, signal: new AbortController().signal, assertCurrent() {}, catalog: { papers: () => [paper!], projects: () => [project!] } }
    const input = { paperId: id, projectIds: [project!.id], question: '恢复问题', claim: '相同判断', quote: '  第一版😀\n\n', method: '人工', datasetOrMaterial: '合成', finding: '保留相反证据', limitation: '', comment: `自由文本 ${root}`, relation: 'supports' as const, locator: { pageStart: 1 } }
    const first = createEvidence(scope, input, 0)
    const edited = updateEvidence(scope, first.card.id, { ...input, quote: '  第二版😀\n\n' }, first.document.revision)
    const checked = reviseEvidence(scope, first.card.id, edited.document.revision, previous => ({ ...previous, reviewState: 'checked', documentBinding: { sha256: createHash('sha256').update(pdf).digest('hex'), size: pdf.length, checkedAt: new Date().toISOString() } }))
    const archived = archiveEvidence(scope, first.card.id, true, checked.document.revision)
    createEvidence(scope, { ...input, question: '反对证据', relation: 'opposes' }, archived.document.revision)
    const evidencePath = join('.mimir', 'library', 'evidence.json')
    const evidenceBefore = readFileSync(join(root, evidencePath))
    const original = JSON.parse(evidenceBefore.toString())
    expect(original.cards[0].versions).toHaveLength(4)
    expect(original.cards[0].versions[3].documentBinding.sha256).toBe(createHash('sha256').update(pdf).digest('hex'))
    const dbPath = join(root, '.mimir/assets/assets.db')
    if (withAssets) {
      mkdirSync(dirname(dbPath), { recursive: true }); db = new Database(dbPath)
      db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0')
      for (const sql of ASSETS_DDL) db.exec(sql)
      db.pragma(`user_version=${ASSETS_SCHEMA_VERSION}`); db.pragma('wal_checkpoint(TRUNCATE)')
      db.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('inbox', 'WAL保留', '2026-10-17')
      expect(readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(0)
    } else expect(existsSync(dbPath)).toBe(false)
    const before = hashes(root), walBefore = withAssets ? readFileSync(`${dbPath}-wal`) : null
    const registryPath = join(ctx.tempHome.home, '.mimir/store.json')
    const registryBefore = JSON.parse(readFileSync(registryPath, 'utf8'))
    const backup = await ctx.page.evaluate(async () => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
      const overview = await api.overview()
      if (!overview.ok || !api.backupSpace) throw Error('维护入口不可用')
      return api.backupSpace({ spaceId: overview.spaces[0].id })
    })
    expect(backup, JSON.stringify(backup)).toMatchObject({ ok: true, hasAssetsDb: withAssets })
    const targetRoot = join(ctx.tempHome.home, 'Mimir', `恢复证据-${withAssets}`)
    const restored = await ctx.page.evaluate(async targetRoot => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
      const overview = await api.overview()
      if (!overview.ok || !overview.archives?.length || !api.restore) throw Error('恢复入口不可用')
      return api.restore({ archivePath: overview.archives[0].path, targetRoot, spaceName: '恢复证据' })
    }, targetRoot)
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true, root: targetRoot })
    expect(readFileSync(join(targetRoot, evidencePath))).toEqual(evidenceBefore)
    expect(readFileSync(join(targetRoot, 'papers', paperPdfFileName(id)))).toEqual(pdf)
    expect(hashes(root)).toEqual(before)
    if (walBefore) expect(readFileSync(`${dbPath}-wal`)).toEqual(walBefore)
    if (withAssets) {
      const restoredDb = new Database(join(targetRoot, '.mimir/assets/assets.db'), { readonly: true })
      try { expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok'); expect(restoredDb.prepare('SELECT name FROM asset_category WHERE code=?').get('inbox')).toEqual({ name: 'WAL保留' }) }
      finally { restoredDb.close() }
    } else expect(existsSync(join(targetRoot, '.mimir/assets/assets.db'))).toBe(false)
    const registryAfter = JSON.parse(readFileSync(registryPath, 'utf8'))
    expect(registryAfter['workspaces:list']).toHaveLength(registryBefore['workspaces:list'].length + 1)
    expect(registryAfter.activeWorkspaceId).toBe(registryBefore.activeWorkspaceId)
    expect(registryAfter.defaultWorkspaceId).toBe(registryBefore.defaultWorkspaceId)
    const restoredId = registryAfter['workspaces:list'].find((s: any) => s.path === targetRoot).id
    // 字节不变的断言在关闭 fixture WAL 之前完成，避免 SQLite 关库 checkpoint 混入恢复判断。
    db?.close(); db = undefined
    const reopened = await reopenEvidenceApp(ctx); restarted = reopened.app
    const switched = await reopened.page.evaluate(id => window.electronAPI!.workspaces.switch(id), restoredId)
    expect(switched, JSON.stringify(switched)).toMatchObject({ ok: true })
    await reopened.page.reload()
    await gotoModule(reopened.page, 'library')
    await reopened.page.getByRole('button', { name: `证据卡：${title}`, exact: true }).click()
    const reader = reopened.page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await reader.getByLabel('包含归档').check()
    await reader.getByRole('button', { name: /^恢复问题 ·/ }).click()
    await expect(reader.getByLabel('查看证据版本')).toHaveValue('4')
    await reader.getByLabel('查看证据版本').selectOption('1')
    await expect(reader.getByTestId('evidence-history-quote')).toHaveText('  第一版😀\n\n')
    const source = await reopened.page.evaluate(async cardId => {
      const api = window.electronAPI!.libraryEvidence, boot = await api.list({ filter: { archive: 'exclude', source: 'all' }, page: 1 })
      if (!boot.ok) throw Error(boot.message)
      const inspected = await api.checkSource({ scope: boot.scope, cardId, version: 4, mode: 'inspect' })
      const opened = await api.openSource({ scope: boot.scope, cardId, version: 4 })
      return { inspected, opened }
    }, first.card.id)
    expect(source.inspected).toMatchObject({ ok: true, inspection: { status: 'available' } })
    expect(source.opened).toMatchObject({ ok: true, source: { status: 'available', requestedPage: 1, locationMode: 'manual-page' } })
    if (!source.opened.ok) throw Error('来源打开失败')
    const actualPdf = await restarted.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url!)
      return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) }
    }, source.opened.source.pdfUrl)
    expect(actualPdf.status).toBe(200)
    expect(Buffer.from(actualPdf.bytes)).toEqual(pdf)
    expect(readFileSync(join(targetRoot, evidencePath))).toEqual(evidenceBefore)
  } finally {
    try { db?.close(); await restarted?.close() } finally { await ctx.cleanup() }
  }
})
