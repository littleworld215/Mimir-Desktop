import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { expect, test } from '@playwright/test'
import Database from 'better-sqlite3'
import { ASSETS_DDL, ASSETS_SCHEMA_VERSION } from '../../electron/assets/schema'
import PptxGenJS from 'pptxgenjs'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createEditingRepository } from '../../electron/libraryEditing/repository'
import { emptyPlanningDocument, emptyPlanningInput } from '../../shared/researchPlanningDefaults'
import { launchApp } from '../fixtures/launch'
import { seedResearch } from '../fixtures/libraryResearch'
import { reopenEvidenceApp } from '../fixtures/libraryEvidence'
import { gotoModule } from '../helpers/nav'
import { attachBackupEvidence } from '../fixtures/backupEvidence'

function inventory(root: string) {
  const files: Record<string, string> = {}
  const excluded = new Set(['.mimir/workspace.writer-lock', '.mimir/assets/assets.db.writer-lock', '.mimir/assets/assets.db-wal', '.mimir/assets/assets.db-shm'])
  const visit = (folder: string) => { for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name), key = relative(root, file).replaceAll('\\', '/')
    if (entry.isDirectory()) visit(file)
    else if (!excluded.has(key)) files[key] = createHash('sha256').update(readFileSync(file)).digest('hex')
  } }
  visit(root); return files
}
const stamp = '2026-10-27T00:00:00.000Z'
const assetTables = ['asset_category', 'asset', 'asset_version', 'tag', 'asset_tag', 'asset_reference', 'saved_filter', 'ai_draft', 'asset_fts'] as const
const assetRows = (database: Database.Database) => Object.fromEntries(assetTables.map(name => [
  name, database.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all()
]))

test('G08综合空间：全部业务资料同包恢复，WAL/历史/草稿保全，重启逐入口可用', async () => {
  test.setTimeout(240_000)
  let f!: ReturnType<typeof seedResearch>, sourceId = ''
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const ctx = await launchApp({
    executablePath: process.env.MIMIR_E2E_PACKAGED,
    maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true, extraArgs: ['--workspace-maintenance'],
    transformSeed: seed => {
      f = seedResearch(seed); sourceId = seed.workspaces[0]!.id
      const root = f.root, project = join(root, 'projects', '合成课题'), artifact = join(root, 'outputs', '聊天产物.txt')
      return { ...f.seed, spaceData: { ...f.seed.spaceData,
        'library:projects': f.projects.map(p => ({ ...p, ...(p.id === 'research-project' ? { paperDir: project } : {}) })),
        'paper.recentProjects': [{ dir: project, at: 1 }],
        'chat:conversations': [{ id: 'g08-chat', title: 'G08合成聊天', createdAt: stamp, messages: [{
          id: 'g08-message', role: 'assistant', content: 'G08聊天历史正文 ' + root, timestamp: stamp,
          artifacts: [{ path: artifact, name: '聊天产物.txt', ext: '.txt' }],
          run: { status: 'done', startedAt: 1, steps: [{ id: 'step', kind: 'tool', title: '历史记录', status: 'done', artifacts: [artifact] }] }
        }] }], 'chat:activeConvId': 'g08-chat',
        'ledger:entries': [{ id: 'g08-ledger', title: 'G08科研进展', content: '合成记录正文', type: 'progress', date: '2026-10-27' }],
        'experiments:list': [{ id: 'g08-experiment', name: 'G08合成实验记录', status: 'success', metrics: { synthetic: 1 }, updatedAt: stamp }],
        'figures:list': [{ id: 'g08-figure', name: 'G08合成图表', fileName: 'g08.png', sizeBytes: png.length, createdAt: stamp }],
        'meetings:index': { 'g08.pptx': { title: 'G08合成组会', slides: 1, createdAt: stamp } },
        unknown: { body: root, nested: { path: join(root, 'unknown-do-not-remap') } }
      } }
    }
  })
  let db: Database.Database | undefined, reopened: Awaited<ReturnType<typeof reopenEvidenceApp>> | undefined
  const put = (name: string, bytes: string | Buffer) => { const file = join(f.root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes) }
  try {
    put('projects/合成课题/main.tex', '科研项目源文件，不执行编译\n')
    put('outputs/聊天产物.txt', '合成历史产物\n')
    put('wiki/研究笔记.md', '# 合成Wiki\n\n' + f.root)
    put('figures/g08.png', png); put('.hidden/未知资料.bin', Buffer.from([0, 255, 11, 99]))
    put('.mimir/plugins/g08-config.json', JSON.stringify({ enabled: false, synthetic: true, body: f.root }))
    const deck = new PptxGenJS(); deck.addSlide().addText('G08 synthetic meeting', { x: 1, y: 1, w: 6, h: 1 })
    mkdirSync(join(f.root, 'meetings'), { recursive: true }); await deck.writeFile({ fileName: join(f.root, 'meetings/g08.pptx') })
    const plan = emptyPlanningDocument(); plan.revision = 1
    plan.items.push(
      { ...emptyPlanningInput('project'), id: 'g08-project', title: 'G08恢复计划', libraryProjectId: 'research-project', createdAt: stamp, updatedAt: stamp },
      { ...emptyPlanningInput('todo'), id: 'g08-todo', title: 'G08恢复待办', projectId: 'g08-project', dueDate: '2026-10-27', createdAt: stamp, updatedAt: stamp }
    )
    put('.mimir/planning/planning.json', JSON.stringify(plan))
    put('.mimir/planning/drafts.json', JSON.stringify({ schemaVersion: 1, revision: 1, drafts: [{ id: 'g08-draft', itemId: null, baseRevision: 1, input: { ...emptyPlanningInput('generic'), title: 'G08未保存记录', content: '\n 合成草稿原文 \n' }, updatedAt: stamp }] }))
    put('.mimir/planning/deliveries.json', JSON.stringify({ schemaVersion: 1, revision: 1, deliveries: [{ itemId: 'g08-todo', dueDate: '2026-10-27', deliveredAt: stamp }] }))
    createEditingRepository().commit(f.root, 0, { schemaVersion: 1, revision: 1, drafts: [{
      id: randomUUID(), paperId: f.papers[0]!.arxivId, kind: 'notes', base: { notes: f.papers[0]!.notes },
      input: '\n G08文献恢复草稿 \n', revision: 1, updatedAt: stamp
    }] }, () => {})
    // 构造离线业务数据，不从Node测试进程导入依赖Electron app的真实store。
    const textId = 1, fileId = 2
    put('.mimir/assets/files/2/v1.bin', '旧附件原文')
    put('.mimir/assets/files/2/v2.bin', '新附件原文')
    const dbPath = join(f.root, '.mimir/assets/assets.db')
    db = new Database(dbPath)
    db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0')
    for (const ddl of ASSETS_DDL) db.exec(ddl)
    db.pragma('user_version=' + ASSETS_SCHEMA_VERSION); db.pragma('wal_checkpoint(TRUNCATE)')
    db.transaction(() => {
      db!.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('inbox', '未分类', stamp)
      db!.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('g08-wal', 'G08仅WAL分类', stamp)
      const asset = db!.prepare('INSERT INTO asset(id,code,name,category,storage_type,is_favorite,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      asset.run(textId, 'g08-text', 'G08合成文本资产', 'inbox', 'inline_text', 1, stamp, stamp)
      asset.run(fileId, 'g08-file', 'G08历史附件', 'inbox', 'file', 0, stamp, stamp)
      const version = db!.prepare('INSERT INTO asset_version(id,asset_id,version,content,file_path,file_name,created_at) VALUES(?,?,?,?,?,?,?)')
      version.run(1, textId, 1, '第一版\n', null, null, stamp)
      version.run(2, textId, 2, '第二版\n', null, null, stamp)
      version.run(3, fileId, 1, '', 'files/2/v1.bin', '旧附件.bin', stamp)
      version.run(4, fileId, 2, '', 'files/2/v2.bin', '新附件.bin', stamp)
      db!.prepare('UPDATE asset SET current_version_id=? WHERE id=?').run(2, textId)
      db!.prepare('UPDATE asset SET current_version_id=? WHERE id=?').run(4, fileId)
      db!.prepare('INSERT INTO tag(id,name,normalized_name) VALUES(1,?,?)').run('G08标签', 'g08标签')
      db!.prepare('INSERT INTO asset_tag(asset_id,tag_id) VALUES(?,1)').run(textId)
      db!.prepare('INSERT INTO asset_reference(source_asset_id,target_asset_id,created_at) VALUES(?,?,?)').run(textId, fileId, stamp)
      db!.prepare('INSERT INTO ai_draft(asset_id,source_version_id,source_revision,mode,content,model,prompt_snapshot,usage_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(textId, 1, 1, 'polish', 'G08待采纳草稿', 'synthetic', '合成提示', '{}', stamp)
    })()
    const wal = readFileSync(dbPath + '-wal'); expect(wal.length).toBeGreaterThan(0)
    const originalRows = assetRows(db)
    const before = inventory(f.root)
    const registryPath = join(ctx.tempHome.home, '.mimir/store.json'), registry = JSON.parse(readFileSync(registryPath, 'utf8'))
    if (process.env.MIMIR_E2E_PACKAGED) await ctx.app.evaluate((_e, cwd) => process.chdir(cwd), ctx.tempHome.root)
    const targetRoot = join(ctx.tempHome.home, 'Mimir', 'G08综合恢复空间')
    const outcome = await ctx.page.evaluate(async targetRoot => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance, overview = await api.overview()
      if (!overview.ok || !api.backupSpace || !api.restore) throw Error('Maintenance unavailable')
      const backup = await api.backupSpace({ spaceId: overview.spaces[0]!.id })
      if (!backup.ok) throw Error(JSON.stringify(backup))
      const latest = await api.overview(); if (!latest.ok || !latest.archives?.length) throw Error('Archive unavailable')
      return { backup, restored: await api.restore({ archivePath: latest.archives[0]!.path, targetRoot, spaceName: 'G08综合恢复空间' }) }
    }, targetRoot)
    expect(outcome.backup).toMatchObject({ ok: true, hasAssetsDb: true, excluded: 0 })
    expect(outcome.restored, JSON.stringify(outcome.restored)).toMatchObject({ ok: true })
    expect(inventory(f.root)).toEqual(before); expect(readFileSync(dbPath + '-wal')).toEqual(wal)
    const restoredInventory = inventory(targetRoot)
    for (const [name, sha] of Object.entries(before)) {
      if (name === '.mimir/store.json' || name === '.mimir/assets/assets.db') continue
      expect(restoredInventory[name], name).toBe(sha)
    }
    const next = JSON.parse(readFileSync(registryPath, 'utf8'))
    expect(next['workspaces:list']).toHaveLength(registry['workspaces:list'].length + 1)
    expect(next.activeWorkspaceId).toBe(registry.activeWorkspaceId); expect(next.defaultWorkspaceId).toBe(registry.defaultWorkspaceId)
    const newId = next['workspaces:list'].find((s: { path: string }) => s.path === targetRoot).id
    const restoredStore = JSON.parse(readFileSync(join(targetRoot, '.mimir/store.json'), 'utf8'))
    expect(restoredStore.unknown.body).toBe(f.root)
    expect(restoredStore['chat:conversations'][0].messages[0].content).toContain(f.root)
    expect(restoredStore['chat:conversations'][0].messages[0].artifacts[0].path).toBe(join(targetRoot, 'outputs/聊天产物.txt'))
    const restoredDb = new Database(join(targetRoot, '.mimir/assets/assets.db'), { readonly: true })
    try {
      expect(assetRows(restoredDb)).toEqual(originalRows)
      expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok'); expect(restoredDb.pragma('foreign_key_check')).toEqual([])
      expect(restoredDb.prepare('SELECT COUNT(*) n FROM asset_version WHERE asset_id=?').get(textId)).toEqual({ n: 2 })
      expect(restoredDb.prepare('SELECT COUNT(*) n FROM asset_version WHERE asset_id=?').get(fileId)).toEqual({ n: 2 })
      expect(restoredDb.prepare('SELECT content FROM ai_draft').get()).toEqual({ content: 'G08待采纳草稿' })
      expect(restoredDb.prepare('SELECT name FROM asset_category WHERE code=?').get('g08-wal')).toEqual({ name: 'G08仅WAL分类' })
    } finally { restoredDb.close() }
    db.close(); db = undefined
    reopened = await reopenEvidenceApp(ctx)
    expect(await reopened.page.evaluate(id => window.electronAPI!.workspaces.switch(id), newId)).toMatchObject({ ok: true })
    await reopened.page.reload()
    for (const [module, title] of [
      ['assets', 'G08合成文本资产'], ['planning', 'G08恢复计划'], ['ledger', 'G08科研进展'],
      ['experiments', 'G08合成实验记录'], ['figures', 'G08合成图表'], ['meetings', 'G08合成组会'],
      ['library', '研究文献0'], ['chat', 'G08合成聊天']
    ] as const) {
      await gotoModule(reopened.page, module)
      await expect(reopened.page.getByText(title, { exact: true }).first()).toBeVisible()
    }
    const source = await reopened.page.evaluate(async cardId => {
      const api = window.electronAPI!.libraryEvidence, boot = await api.list({ filter: { archive: 'exclude', source: 'all' }, page: 1 })
      if (!boot.ok) throw Error('Evidence unavailable')
      return api.openSource({ scope: boot.scope, cardId, version: 2 })
    }, f.cards[0]!.id)
    expect(source).toMatchObject({ ok: true, source: { status: 'available' } })
    if (!source.ok) throw Error('PDF unavailable')
    const bytes = await reopened.app.evaluate(async ({ net }, url) => Array.from(new Uint8Array(await (await net.fetch(url!)).arrayBuffer())), source.source.pdfUrl)
    expect(Buffer.from(bytes)).toEqual(f.pdf)
    await attachBackupEvidence(test.info(), 'comprehensive-evidence', {
      sourceFiles: Object.keys(before).length, restoredFiles: Object.keys(restoredInventory).length, walBytes: wal.length,
      textVersions: 2, fileVersions: 2, evidenceCards: f.cards.length, questionGroups: f.questions.length,
      sourceUnchanged: true, comparedAssetTables: assetTables, windowsModulesOpened: 8, syntheticOnly: true
    })
  } finally { try { db?.close(); await reopened?.app.close() } finally { await ctx.cleanup() } }
})
