import { test, expect, _electron as electron } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { ASSETS_DDL } from '../../electron/assets/schema'
import { createBackup } from '../../electron/workspaceBackup/packer'
import { readArchiveManifest } from '../../electron/workspaceBackup/restoreArchive'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { launchApp, mainEntry } from '../fixtures/launch'
import { evidencePdf } from '../fixtures/libraryEvidence'
import { gotoModule } from '../helpers/nav'

const key = (dir: string) => createHash('sha1').update(dir).digest('hex').slice(0, 16)
const template = { includeHeader: true, includeSource: true, includeNotes: true, includeTags: false, sections: [{ key: 'prompt', title: 'G04恢复模板' }] }
function hashes(root: string) {
  const out: Record<string, string> = {}
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (!/writer-lock$/.test(entry.name)) out[relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex')
  } }
  walk(root); return out
}

for (const scenario of ['source-id', 'legacy-unique', 'legacy-ambiguous', 'snapshot-conflict'] as const) {
  test(`真实恢复关联 ${scenario}：PDF/项目/快照/模板可用，正文与源不变`, async () => {
    test.setTimeout(120_000)
    let sourceRoot = '', sourceId = ''
    const paperId = 'doi:10.1/g04', title = 'G04合成文献'
    const pdfName = `${encodeURIComponent(paperId)}.pdf`
    const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, extraArgs: ['--workspace-maintenance'], transformSeed: seed => {
      sourceRoot = seed.workspaces[0].path; sourceId = seed.workspaces[0].id
      const project = join(sourceRoot, '科研项目'), artifact = join(sourceRoot, 'outputs/产物.txt')
      return { ...seed, spaceData: {
        'library:papers': { [paperId]: { arxivId: paperId, title, authors: ['合成'], summary: sourceRoot, url: 'https://example.invalid/g04', notes: sourceRoot,
          tags: [], projectIds: ['project'], addedAt: '2026-10-24', pdfPath: join(sourceRoot, 'papers', pdfName) } },
        'library:projects': [{ id: 'project', title: '科研项目', paperDir: project, createdAt: '2026-10-24', updatedAt: '2026-10-24' },
          ...(scenario === 'source-id' ? [{ id: 'external-project', title: '外部合成项目', paperDir: join(dirname(sourceRoot), 'external-project'), createdAt: '2026-10-24', updatedAt: '2026-10-24' }] : [])],
        'paper.recentProjects': [{ dir: project, at: 1 }],
        'chat:conversations': [{ id: 'chat', title: '合成聊天', createdAt: '2026-10-24', messages: [{ id: 'message', role: 'assistant', content: sourceRoot,
          timestamp: '2026-10-24', artifacts: [{ path: artifact, name: '产物.txt', ext: '.txt' }],
          run: { status: 'done', startedAt: 1, steps: [{ id: 'tool', kind: 'tool', title: '合成工具', status: 'done', resultSummary: sourceRoot, artifacts: [artifact] }] } }] }],
        'chat:activeConvId': 'chat',
        [`assets-task-pack:${sourceId}`]: template,
        ...(scenario === 'source-id' || scenario === 'legacy-ambiguous' ? { 'assets-task-pack:historical-id': { ...template, includeHeader: false } } : {}),
        unknown: { text: sourceRoot, path: join(sourceRoot, 'unknown'), list: [1, 2] }
      } }
    } })
    try {
      const targetRoot = join(dirname(sourceRoot), `新关联空间-${scenario}`)
      const project = join(sourceRoot, '科研项目'), newProject = join(targetRoot, '科研项目')
      for (const [file, content] of [['科研项目/main.tex', '当前论文正文\n'], ['outputs/产物.txt', '聊天产物\n']] as const) {
        mkdirSync(dirname(join(sourceRoot, file)), { recursive: true }); writeFileSync(join(sourceRoot, file), content)
      }
      mkdirSync(join(sourceRoot, 'papers'), { recursive: true })
      const pdf = evidencePdf('Synthetic G04 PDF')
      writeFileSync(join(sourceRoot, 'papers', pdfName), pdf)
      const snapshots = join(sourceRoot, '.mimir/paper-snapshots')
      const history = '历史快照正文\n'
      mkdirSync(join(snapshots, key(project), 'snapshot-1'), { recursive: true })
      writeFileSync(join(snapshots, key(project), 'snapshot-1/main.tex'), history)
      writeFileSync(join(snapshots, key(project), 'snapshot-1/manifest.json'), JSON.stringify({ id: 'snapshot-1', createdAt: '2026-10-24', files: [{ path: 'main.tex', sizeBytes: Buffer.byteLength(history) }] }))
      mkdirSync(join(snapshots, 'unknown-bucket')); writeFileSync(join(snapshots, 'unknown-bucket/keep.txt'), '保留未知资料')
      const external = join(dirname(sourceRoot), 'external-project')
      if (scenario === 'source-id') {
        mkdirSync(external)
        writeFileSync(join(external, 'main.tex'), '外部项目未选入\n')
        mkdirSync(join(snapshots, key(external)))
        writeFileSync(join(snapshots, key(external), 'preserved.txt'), '已存外部项目快照')
      }
      if (scenario === 'snapshot-conflict') mkdirSync(join(snapshots, key(newProject)))
      const dbPath = join(sourceRoot, '.mimir/assets/assets.db')
      mkdirSync(dirname(dbPath), { recursive: true })
      const db = new Database(dbPath)
      try {
        for (const ddl of ASSETS_DDL) db.exec(ddl)
        db.pragma('user_version=4')
        db.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('inbox', '未分类', '2026-10-24')
        db.prepare('INSERT INTO asset(id,code,name,category,storage_type,kind,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)').run('g04-asset', 'G04资产', 'inbox', 'inline_text', 'prompt', '2026-10-24', '2026-10-24')
        db.prepare('INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(1,1,1,?,?)').run(sourceRoot, '2026-10-24')
        db.exec('UPDATE asset SET current_version_id=1 WHERE id=1')
      } finally { db.close() }
      const before = hashes(sourceRoot), registry = join(ctx.tempHome.home, '.mimir/store.json'), registryBefore = readFileSync(registry)
      let archivePath: string
      if (scenario === 'source-id') {
        const result = await ctx.page.evaluate(async id => {
          const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
          if (!api.backupSpace) throw Error('No backup entry')
          return api.backupSpace({ spaceId: id })
        }, sourceId)
        expect(result.ok, JSON.stringify(result)).toBe(true)
        const overview = await ctx.page.evaluate(() => (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance.overview())
        if (!overview.ok || !overview.archives?.[0]) throw Error('Missing archive')
        archivePath = overview.archives[0].path
        expect(await readArchiveManifest(archivePath)).toMatchObject({ sourceSpaceId: sourceId })
      } else {
        const archives = join(ctx.tempHome.home, 'backups'); mkdirSync(archives, { recursive: true })
        archivePath = join(archives, 'mimir-backup-associations-20261024-000001.zip')
        const reader = new Database(dbPath, { readonly: true })
        try { await createBackup({ root: sourceRoot, destination: archivePath, stagingDir: join(ctx.tempHome.root, 'packing'), assetsDb: reader, assetsDbRelPath: '.mimir/assets/assets.db' }) }
        finally { reader.close() }
      }
      const archiveBefore = readFileSync(archivePath)
      const result = await ctx.page.evaluate(async request => {
        const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
        if (!api.restore) throw Error('No restore entry')
        return api.restore(request)
      }, { archivePath, targetRoot, spaceName: '新关联空间' })
      const failed = scenario === 'legacy-ambiguous' || scenario === 'snapshot-conflict'
      if (failed) {
        expect(result).toMatchObject({ ok: false, code: 'RECHECK_FAILED' })
        expect(existsSync(targetRoot)).toBe(false); expect(readFileSync(registry)).toEqual(registryBefore)
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, associations: { snapshotsRelinked: 1, unknownSnapshotBuckets: 1, templatesRelinked: 1,
          externalSnapshotBuckets: scenario === 'source-id' ? 1 : 0 } })
        if (!result.ok) throw Error('Unreachable')
        const store = JSON.parse(readFileSync(join(targetRoot, '.mimir/store.json'), 'utf8'))
        expect(store.unknown).toEqual(JSON.parse(readFileSync(join(sourceRoot, '.mimir/store.json'), 'utf8')).unknown)
        expect(store['library:projects'][0].paperDir).toBe(newProject)
        expect(store['paper.recentProjects'][0].dir).toBe(newProject)
        expect(store['chat:conversations'][0].messages[0].content).toBe(sourceRoot)
        expect(store['chat:conversations'][0].messages[0].run.steps[0].resultSummary).toBe(sourceRoot)
        const newArtifact = join(targetRoot, 'outputs/产物.txt')
        expect(store['chat:conversations'][0].messages[0].artifacts[0].path).toBe(newArtifact)
        expect(store['chat:conversations'][0].messages[0].run.steps[0].artifacts[0]).toBe(newArtifact)
        expect(readFileSync(newArtifact, 'utf8')).toBe('聊天产物\n')
        expect(store['assets-task-pack:' + result.spaceId]).toEqual(template)
        expect(readFileSync(join(targetRoot, '.mimir/paper-snapshots/unknown-bucket/keep.txt'), 'utf8')).toBe('保留未知资料')
        if (scenario === 'source-id') {
          expect(store['library:projects'][1].paperDir).toBe(external)
          expect(readFileSync(join(targetRoot, '.mimir/paper-snapshots', key(external), 'preserved.txt'), 'utf8')).toBe('已存外部项目快照')
          expect(readFileSync(join(external, 'main.tex'), 'utf8')).toBe('外部项目未选入\n')
          expect(existsSync(join(targetRoot, 'external-project/main.tex'))).toBe(false)
        }
        const after = JSON.parse(readFileSync(registry, 'utf8')), previous = JSON.parse(registryBefore.toString())
        expect(after.activeWorkspaceId).toEqual(previous.activeWorkspaceId); expect(after.defaultWorkspaceId).toEqual(previous.defaultWorkspaceId)
        // 先核对恢复没有改激活指针，再关闭维护；仅测试准备把隔离profile指向恢复空间，避免正常启动原空间带来业务写入。
        await ctx.app.close()
        after.activeWorkspaceId = result.spaceId
        writeFileSync(registry, JSON.stringify(after))
        const normal = await electron.launch({ executablePath: process.env.MIMIR_E2E_PACKAGED,
          args: [...(process.env.MIMIR_E2E_PACKAGED ? [] : [mainEntry]), `--user-data-dir=${ctx.tempHome.userData}`],
          cwd: process.env.MIMIR_E2E_PACKAGED ? ctx.tempHome.root : process.cwd(),
          env: { ...process.env, HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' } })
        try {
          const page = await normal.firstWindow(); await page.waitForLoadState('domcontentloaded')
          await page.waitForFunction(() => Boolean(window.electronAPI?.workspaces))
          const actual = await normal.evaluate(({ app }) => ({ home: process.getBuiltinModule('os').homedir(), userData: app.getPath('userData') }))
          expect(realpathSync(actual.home)).toBe(realpathSync(ctx.tempHome.home)); expect(realpathSync(actual.userData)).toBe(realpathSync(ctx.tempHome.userData))
          const opened = await page.evaluate(async dir => {
            const api = window.electronAPI!
            return { project: await api.latex.readFile(dir, 'main.tex'), snapshots: await api.snapshots.list(dir), history: await api.snapshots.read(dir, 'snapshot-1', 'main.tex'),
            }
          }, newProject)
          const openedPdf = await normal.evaluate(async ({ net }, paperId) => {
            const response = await net.fetch(`mimir-pdf://paper/${encodeURIComponent(paperId)}.pdf`)
            return { status: response.status, size: (await response.arrayBuffer()).byteLength }
          }, paperId)
          expect(opened.project).toMatchObject({ ok: true, content: '当前论文正文\n' }); expect(opened.history).toMatchObject({ ok: true, content: history })
          expect(opened.snapshots.snapshots?.map(s => s.id)).toContain('snapshot-1'); expect(openedPdf).toEqual({ status: 200, size: pdf.length })
          await gotoModule(page, 'library')
          await page.getByRole('button', { name: `证据卡：${title}`, exact: true }).click()
          const reader = page.getByRole('dialog', { name: '文献阅读器', exact: true })
          await expect(reader.locator('iframe')).toHaveAttribute('src', `mimir-pdf://paper/${encodeURIComponent(paperId)}.pdf`)
          await expect(reader.locator('iframe')).toBeVisible()
          await reader.getByTitle('关闭', { exact: true }).click()
          await gotoModule(page, 'assets')
          await page.getByRole('checkbox', { name: '选择G04资产', exact: true }).check()
          await page.getByRole('button', { name: '组合任务包', exact: true }).click()
          await expect(page.getByLabel('任务包预览')).toContainText('G04恢复模板')
          await expect(page.getByLabel('任务包预览')).toContainText(sourceRoot)
          await page.getByRole('dialog', { name: '任务包组合复制', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
          const artifactPaths = await page.evaluate(async () => {
            const api = window.electronAPI!
            const conversations = await api.getStoreValue<{ messages: { artifacts: { path: string }[]; run: { steps: { artifacts: string[] }[] } }[] }[]>('chat:conversations')
            const message = conversations![0].messages[0]
            const paths = [message.artifacts[0].path, message.run.steps[0].artifacts[0]]
            return paths
          })
          expect(artifactPaths).toEqual([newArtifact, newArtifact])
          // 通用fs:readFile仅接受原生选择授权；聊天打开走shell路径授权，不伪造文件选择。
          expect(artifactPaths.map(path => readFileSync(path, 'utf8'))).toEqual(['聊天产物\n', '聊天产物\n'])
          await normal.evaluate(({ shell }) => {
            const state = globalThis as unknown as { g04OpenedPaths: string[] }
            state.g04OpenedPaths = []
            // 保留真实渲染→IPC→路径授权；只截住外部应用启动，不打开用户编辑器。
            shell.openPath = async path => { state.g04OpenedPaths.push(path); return '' }
          })
          await gotoModule(page, 'chat')
          await page.getByTitle('打开文件', { exact: true }).first().click()
          await expect.poll(() => normal.evaluate(() => (globalThis as unknown as { g04OpenedPaths: string[] }).g04OpenedPaths)).toEqual([newArtifact])
        } finally { await normal.close() }
      }
      expect(hashes(sourceRoot)).toEqual(before); expect(readFileSync(archivePath)).toEqual(archiveBefore)
    } finally { await ctx.cleanup() }
  })
}
