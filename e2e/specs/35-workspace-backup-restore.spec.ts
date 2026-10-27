import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { ASSETS_DDL, ASSETS_SCHEMA_VERSION } from '../../electron/assets/schema'
import { createBackup } from '../../electron/workspaceBackup/packer'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { launchApp } from '../fixtures/launch'
import { createEditingRepository } from '../../electron/libraryEditing/repository'
import { randomUUID } from 'node:crypto'
import { reopenEvidenceApp } from '../fixtures/libraryEvidence'

/** 对照源字节；SQLite共享内存与运行锁不属于业务资料。WAL另行核对。 */
function sourceHashes(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (!/(?:assets\.db-(?:wal|shm)|writer-lock)$/i.test(entry.name)) {
        files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  walk(root)
  return files
}

for (const scenario of ['backup-restore', 'restore-only', 'invalid-db', 'case-db'] as const) {
test(`维护IPC真实SQLite/WAL ${scenario} (${process.env.MIMIR_E2E_PACKAGED ? 'packaged' : 'development'})`, async () => {
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'I6维护首版限Windows x64')
  let sourceDb: Database.Database | undefined
  let sourceRoot = ''
  const pdfName = '论文😀.pdf'
  const contents = ['  第一版\n\n', '第二版😀\n']
  const ordinaryFiles = ['notes/实验-journal', '.hidden/项目-wal/记录.txt', 'other/cache.db-shm']
  const ctx = await launchApp({
    executablePath: process.env.MIMIR_E2E_PACKAGED,
    maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true, extraArgs: ['--workspace-maintenance'],
    transformSeed: seed => {
      sourceRoot = seed.workspaces[0].path
      return { ...seed, spaceData: {
        'library:papers': { synthetic: { arxivId: 'synthetic', title: '合成文献', notes: '', tags: [], pdfPath: join(sourceRoot, 'papers', pdfName) } },
        unknown: { text: `自由文本原样保留 ${sourceRoot}`, list: [1, '隐藏资料'] }
      } }
    }
  })
  try {
    const draft = { id: randomUUID(), paperId: 'synthetic', kind: 'notes' as const, base: { notes: '' }, input: `\n 原路径 ${sourceRoot} \n`, revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' }
    createEditingRepository().commit(sourceRoot, 0, { schemaVersion: 1, revision: 1, drafts: [draft] }, () => {})
    if (process.env.MIMIR_E2E_PACKAGED) {
      // 安装包不能借用开发仓库.cwd下的.native缓存而产生假绿。
      await ctx.app.evaluate((_electron, cwd) => process.chdir(cwd), ctx.tempHome.root)
    }
    // 先启动并校验隔离，再持有WAL句柄；启动失败不会留下未关闭的测试数据库。
    const dbPath = join(sourceRoot, '.mimir/assets', scenario === 'case-db' ? 'ASSETS.DB' : 'assets.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    sourceDb = db
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    for (const statement of ASSETS_DDL) db.exec(statement)
    db.pragma(`user_version = ${ASSETS_SCHEMA_VERSION}`)
    db.pragma('wal_checkpoint(TRUNCATE)')
    // 此后提交只留在WAL；保留静止句柄避免关库自动checkpoint掩盖快照缺陷。
    db.transaction(() => {
      db.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('inbox', '未分类', '2026-10-16')
      db.prepare('INSERT INTO asset(id,code,name,category,storage_type,is_favorite,created_at,updated_at) VALUES(1,?,?,?,?,1,?,?)')
        .run('wal-asset', '合成资产', 'inbox', 'inline_text', '2026-10-16', '2026-10-16')
      const version = db.prepare('INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(?,1,?,?,?)')
      contents.forEach((content, index) => version.run(index + 1, index + 1, content, '2026-10-16'))
      db.prepare('UPDATE asset SET current_version_id=2 WHERE id=1').run()
      db.prepare('INSERT INTO ai_draft(asset_id,source_version_id,source_revision,mode,content,model,prompt_snapshot,usage_json,created_at) VALUES(1,1,1,?,?,?,?,?,?)')
        .run('polish', '待采纳草稿', 'synthetic-model', '合成提示', '{}', '2026-10-16')
    })()
    if (scenario === 'invalid-db') db.exec('DROP TABLE ai_draft')
    mkdirSync(join(sourceRoot, '.hidden'), { recursive: true })
    writeFileSync(join(sourceRoot, '.hidden/资料.bin'), Buffer.from([0, 255, 10, 42]))
    mkdirSync(join(sourceRoot, 'papers'), { recursive: true })
    writeFileSync(join(sourceRoot, 'papers', pdfName), '%PDF-1.7\nsynthetic only\n')
    for (const file of ordinaryFiles) {
      mkdirSync(dirname(join(sourceRoot, file)), { recursive: true })
      writeFileSync(join(sourceRoot, file), `普通资料 ${file}`)
    }
    const walPath = `${dbPath}-wal`
    expect(statSync(walPath).size).toBeGreaterThan(0)
    const before = sourceHashes(sourceRoot)
    const walBefore = readFileSync(walPath)
    const registryPath = join(ctx.tempHome.home, '.mimir/store.json')
    const registryBefore = JSON.parse(readFileSync(registryPath, 'utf8'))
    if (scenario === 'backup-restore' || scenario === 'case-db') {
      const backup = await ctx.page.evaluate(async () => {
        const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
        const overview = await api.overview()
        if (!overview.ok || !api.backupSpace) throw Error('No backup entry')
        return api.backupSpace({ spaceId: overview.spaces[0].id })
      })
      expect(backup, JSON.stringify(backup)).toMatchObject({ ok: true, hasAssetsDb: true })
    } else {
      // 独立准备合法归档，避免“备份先失败”掩盖恢复自身的原生绑定缺陷。
      const archiveDir = join(ctx.tempHome.home, 'backups')
      const stagingDir = join(ctx.tempHome.root, 'archive-staging')
      mkdirSync(archiveDir, { recursive: true })
      mkdirSync(stagingDir)
      await createBackup({ root: sourceRoot, stagingDir,
        destination: join(archiveDir, 'mimir-backup-prepared-20261016-000000.zip'),
        assetsDb: sourceDb, assetsDbRelPath: '.mimir/assets/assets.db' })
    }
    expect(sourceHashes(sourceRoot)).toEqual(before)
    expect(readFileSync(walPath)).toEqual(walBefore)
    const targetRoot = join(ctx.tempHome.home, 'Mimir', '恢复-科研空间')
    expect(existsSync(targetRoot)).toBe(false)
    const restored = await ctx.page.evaluate(async targetRoot => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
      const overview = await api.overview()
      if (!overview.ok || !overview.archives?.length || !api.restore) throw Error('No restore entry')
      return api.restore({ archivePath: overview.archives[0].path, targetRoot, spaceName: '恢复-科研空间' })
    }, targetRoot)
    if (scenario === 'invalid-db') {
      expect(restored, JSON.stringify(restored)).toMatchObject({ ok: false, code: 'INTEGRITY_FAILED' })
      expect(existsSync(targetRoot)).toBe(false)
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual(registryBefore)
      expect(sourceHashes(sourceRoot)).toEqual(before)
      return
    }
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true, root: targetRoot, rewritten: 1 })
    const restoredDb = new Database(join(targetRoot, '.mimir/assets/assets.db'), { readonly: true })
    try {
      expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(restoredDb.pragma('foreign_key_check')).toEqual([])
      expect(restoredDb.prepare('SELECT content FROM asset_version ORDER BY version').all()).toEqual(contents.map(content => ({ content })))
      expect(restoredDb.prepare('SELECT current_version_id,is_favorite FROM asset').get()).toEqual({ current_version_id: 2, is_favorite: 1 })
      expect(restoredDb.prepare('SELECT content FROM ai_draft').get()).toEqual({ content: '待采纳草稿' })
    } finally { restoredDb.close() }
    expect(readFileSync(join(targetRoot, '.hidden/资料.bin'))).toEqual(Buffer.from([0, 255, 10, 42]))
    for (const file of ordinaryFiles) expect(readFileSync(join(targetRoot, file), 'utf8')).toBe(`普通资料 ${file}`)
    expect(readFileSync(join(targetRoot, 'papers', pdfName))).toEqual(readFileSync(join(sourceRoot, 'papers', pdfName)))
    const sourceStore = JSON.parse(readFileSync(join(sourceRoot, '.mimir/store.json'), 'utf8'))
    const restoredStore = JSON.parse(readFileSync(join(targetRoot, '.mimir/store.json'), 'utf8'))
    expect(restoredStore.unknown).toEqual(sourceStore.unknown)
    expect(restoredStore['library:papers'].synthetic.pdfPath).toBe(join(targetRoot, 'papers', pdfName))
    expect(sourceHashes(sourceRoot)).toEqual(before)
    const registryAfter = JSON.parse(readFileSync(registryPath, 'utf8'))
    expect(readFileSync(join(targetRoot, '.mimir/library-editing/drafts.json'))).toEqual(readFileSync(join(sourceRoot, '.mimir/library-editing/drafts.json')))
    expect(registryAfter['workspaces:list']).toHaveLength(registryBefore['workspaces:list'].length + 1)
    expect(registryAfter.activeWorkspaceId).toBe(registryBefore.activeWorkspaceId)
    expect(registryAfter.defaultWorkspaceId).toBe(registryBefore.defaultWorkspaceId)
    expect(existsSync(join(sourceRoot, '.mimir/workspace.writer-lock'))).toBe(false)
    if (scenario === 'backup-restore') {
      sourceDb?.close(); sourceDb = undefined
      const reopened = await reopenEvidenceApp(ctx)
      try {
        const id = registryAfter['workspaces:list'].find((r: any) => r.path === targetRoot).id
        const result = await reopened.page.evaluate(async ({ id, draft }) => {
          if (!(await window.electronAPI!.workspaces.switch(id)).ok) throw Error('switch failed')
          const list = await window.electronAPI!.libraryEditing.list({}); if (!list.ok) return list
          return window.electronAPI!.libraryEditing.open({ scope: list.scope, paperId: 'synthetic', kind: 'notes', resume: { draftId: draft.id, revision: draft.revision } })
        }, { id, draft })
        expect(result).toMatchObject({ ok: true, sessionId: expect.any(String), base: { notes: '' } })
      } finally { await reopened.app.close() }
    }
  } finally {
    try { sourceDb?.close() } finally { await ctx.cleanup() }
  }
})
}
