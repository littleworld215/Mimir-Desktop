import { expect, test, _electron as electron } from '@playwright/test'
import { createHash } from 'node:crypto'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import yauzl from 'yauzl'
import { launchApp, mainEntry } from '../fixtures/launch'
import { createBackup } from '../../electron/workspaceBackup/packer'
import { verifyPrivatePath } from '../../electron/workspaceBackup/privateRegistryAcl'

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
function hashes(root: string) {
  const result: Record<string, string> = {}
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (!entry.name.endsWith('writer-lock')) result[relative(root, path)] = digest(path)
  } }
  walk(root); return result
}
async function prepare(continueScope = false) {
  let source = '', spaceId = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, maintenanceRestoreSuggestions: true,
    maintenanceRestoreScope: continueScope, extraArgs: ['--workspace-maintenance'], transformSeed: seed => {
      source = seed.workspaces[0].path; spaceId = seed.workspaces[0].id; return seed
    } })
  await expect(ctx.page.getByRole('button', { name: '重新读取', exact: true })).toBeEnabled()
  const store = { 'library:papers': { synthetic: { arxivId: 'synthetic', title: 'Synthetic', notes: '', tags: [], pdfPath: 'Q:/SYNTHETIC-G07-PAPER.pdf' } }, unknown: { body: `自由文本不改写 ${source}` } }
  writeFileSync(join(source, '.mimir', 'store.json'), JSON.stringify(store))
  writeFileSync(join(source, 'note.txt'), '合成科研资料\n')
  writeFileSync(join(source, 'excluded.dat'), Buffer.alloc(2048, 7))
  const archive = join(ctx.tempHome.home, 'backups/g07.zip'), targetRoot = join(dirname(source), 'G07恢复空间')
  mkdirSync(dirname(archive), { recursive: true })
  await createBackup({ root: source, destination: archive, stagingDir: join(ctx.tempHome.root, 'packing'), assetsDb: null, sourceSpaceId: spaceId,
    limits: { maxFileBytes: 1024, maxEntries: 100000, maxManifestBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 ** 4 } })
  const registry = join(ctx.tempHome.home, '.mimir/store.json')
  return { ctx, source, spaceId, archive, targetRoot, registry, store, registryBefore: readFileSync(registry), sourceBefore: hashes(source), archiveBefore: digest(archive) }
}
function unchanged(f: Awaited<ReturnType<typeof prepare>>, checkArchive = true) {
  expect(hashes(f.source)).toEqual(f.sourceBefore)
  if (checkArchive) expect(digest(f.archive)).toBe(f.archiveBefore)
}
async function restore(f: Awaited<ReturnType<typeof prepare>>, archive = f.archive) {
  return f.ctx.page.evaluate(request => window.workspaceBackupMaintenance.restore!(request), { archivePath: archive, targetRoot: f.targetRoot, spaceName: 'G07合成恢复' })
}

/** 本测试仅重写几KB的合成归档说明；产品仍流式处理真实内容。 */
async function variant(source: string, destination: string, mutate: (manifest: Record<string, unknown>) => void) {
  const contents = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return }
      const result = new Map<string, Buffer>()
      zip.on('error', reject)
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { result.set(entry.fileName, Buffer.alloc(0)); zip.readEntry(); return }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { reject(error); zip.close(); return }
          const chunks: Buffer[] = []
          stream.on('data', chunk => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => { result.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry() })
        })
      })
      zip.on('end', () => resolve(result)); zip.readEntry()
    })
  })
  const manifest = JSON.parse(contents.get('mimir-manifest.json')!.toString('utf8'))
  mutate(manifest); contents.set('mimir-manifest.json', Buffer.from(JSON.stringify(manifest)))
  const zip = new yazl.ZipFile(), written = pipeline(zip.outputStream, createWriteStream(destination, { flags: 'wx' }))
  for (const [name, bytes] of contents) { if (name.endsWith('/')) zip.addEmptyDirectory(name.slice(0, -1)); else zip.addBuffer(bytes, name) }
  zip.end(); await written
}

test('G07默认拒绝范围确认，不创建暂存/快照或修改登记', async () => {
  const f = await prepare()
  try {
    expect(await restore(f)).toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(existsSync(f.targetRoot)).toBe(false)
    expect(existsSync(join(f.ctx.tempHome.home, '.mimir/restore-operations'))).toBe(false)
    expect(existsSync(join(f.ctx.tempHome.home, '.mimir/restore-registry-snapshots'))).toBe(false)
    expect(readFileSync(f.registry)).toEqual(f.registryBefore); unchanged(f)
  } finally { await f.ctx.cleanup() }
})

test('G07显式恢复与真实私有快照；说明深浅/窄屏/键盘可用，源资料不变', async () => {
  const f = await prepare(true)
  try {
    await f.ctx.page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(f.ctx.page.getByText('未纳入超限项：1；已知外部引用：1；未解析：0。')).toBeVisible()
    expect(await f.ctx.page.locator('body').innerText()).not.toContain('Q:/SYNTHETIC-G07-PAPER.pdf')
    const auditBefore = await f.ctx.page.evaluate(() => window.workspaceBackupMaintenance.auditRecent!())
    const trigger = f.ctx.page.getByRole('button', { name: '展开范围说明', exact: true })
    await trigger.click()
    const dialog = f.ctx.page.getByRole('dialog', { name: '归档范围说明' })
    await expect(dialog.getByText(/Q:\/SYNTHETIC-G07-PAPER.pdf/)).toBeVisible()
    for (const colorScheme of ['light', 'dark'] as const) {
      await f.ctx.page.emulateMedia({ colorScheme })
      await f.ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(540, 680))
      expect(await f.ctx.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await f.ctx.page.screenshot({ path: test.info().outputPath(`g07-scope-${colorScheme}.png`) })
    }
    await f.ctx.page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused()
    expect(await f.ctx.page.evaluate(() => window.workspaceBackupMaintenance.auditRecent!())).toEqual(auditBefore)
    await f.ctx.page.getByRole('button', { name: '恢复为新空间…', exact: true }).click()
    await f.ctx.page.getByLabel('新空间名', { exact: true }).fill('G07合成恢复')
    await f.ctx.page.getByLabel(/目标目录/).fill(f.targetRoot)
    await f.ctx.page.getByRole('button', { name: '开始恢复', exact: true }).click()
    await expect(f.ctx.page.getByRole('status').filter({ hasText: '已恢复到' })).toBeVisible()
    await expect(f.ctx.page.getByText(/已纳入内容校验通过/).first()).toBeVisible()
    expect(readFileSync(join(f.targetRoot, 'note.txt'), 'utf8')).toBe('合成科研资料\n')
    expect(existsSync(join(f.targetRoot, 'excluded.dat'))).toBe(false)
    expect(JSON.parse(readFileSync(join(f.targetRoot, '.mimir/store.json'), 'utf8')).unknown.body).toBe(f.store.unknown.body)
    const directory = join(f.ctx.tempHome.home, '.mimir/restore-registry-snapshots')
    const snapshots = readdirSync(directory).filter(n => n.endsWith('.bak'))
    expect(snapshots).toHaveLength(1)
    expect(readFileSync(join(directory, snapshots[0]))).toEqual(f.registryBefore)
    verifyPrivatePath(directory, 'directory'); verifyPrivatePath(join(directory, snapshots[0]), 'file'); verifyPrivatePath(f.registry, 'file')
    unchanged(f)
  } finally { await f.ctx.cleanup() }
})

for (const mode of ['legacy', 'future'] as const) test(`G07 ${mode}说明兼容/拒绝与实际恢复`, async () => {
  const f = await prepare(true), archive = join(dirname(f.archive), `${mode}.zip`)
  try {
    await variant(f.archive, archive, manifest => { if (mode === 'legacy') delete manifest.metadata; else (manifest.metadata as { version: number }).version = 2 })
    const view = await f.ctx.page.evaluate(() => window.workspaceBackupMaintenance.overview())
    expect(view.ok).toBe(true)
    if (view.ok) {
      const row = view.archives!.find(a => a.name === `${mode}.zip`)!
      if (mode === 'legacy') expect(row.scope).toMatchObject({ metadata: 'legacy-unknown', coverage: 'unknown' })
      else { expect(row.scopeUnavailable).toBe(true); expect(row.archiveId).toBeUndefined() }
    }
    const result = await restore(f, archive)
    if (mode === 'legacy') expect(result).toMatchObject({ ok: true, scope: { metadata: 'legacy-unknown', coverage: 'unknown' } })
    else { expect(result).toMatchObject({ ok: false, code: 'VERSION_UNSUPPORTED' }); expect(existsSync(f.targetRoot)).toBe(false); expect(readFileSync(f.registry)).toEqual(f.registryBefore) }
    unchanged(f)
  } finally { await f.ctx.cleanup() }
})

test('G07快照权限失败保留已发布空间与原登记，恢复后可重试同一UUID', async () => {
  const f = await prepare(true)
  try {
    await f.ctx.app.evaluate(() => {
      const cp = process.getBuiltinModule('child_process'), original = cp.spawnSync
      cp.spawnSync = function (...args) {
        const options = args[2]
        if (options?.env?.MIMIR_REGISTRY_ACL_PATH) return { status: 1, signal: null, stdout: '', stderr: 'synthetic ACL denial', output: [null, '', ''], pid: 0 }
        return original.apply(cp, args)
      }
      ;(globalThis as unknown as { g07OriginalSpawn: typeof cp.spawnSync }).g07OriginalSpawn = original
      process.getBuiltinModule('module').syncBuiltinESMExports()
    })
    expect(await restore(f)).toMatchObject({ ok: false, code: 'REGISTRY_PROTECTION_FAILED' })
    expect(readFileSync(f.registry)).toEqual(f.registryBefore)
    expect(readFileSync(join(f.targetRoot, 'note.txt'), 'utf8')).toBe('合成科研资料\n')
    await f.ctx.app.evaluate(() => {
      const cp = process.getBuiltinModule('child_process')
      cp.spawnSync = (globalThis as unknown as { g07OriginalSpawn: typeof cp.spawnSync }).g07OriginalSpawn
      process.getBuiltinModule('module').syncBuiltinESMExports()
    })
    const list = await f.ctx.page.evaluate(() => window.workspaceBackupMaintenance.recoveryList!())
    const record = list.items.find(i => i.status === 'pending-registration')!
    expect(record).toBeDefined()
    expect(await f.ctx.page.evaluate(id => window.workspaceBackupMaintenance.recoveryAction!({ operationId: id, action: 'register' }), record.operationId)).toMatchObject({ ok: true })
    const registry = JSON.parse(readFileSync(f.registry, 'utf8'))
    expect(registry['workspaces:list']).toHaveLength(2); unchanged(f)
  } finally { await f.ctx.cleanup() }
})

test('G07确认期间归档被改，继续也不创建恢复资料', async () => {
  const f = await prepare(true)
  try {
    await f.ctx.app.evaluate(({ dialog }, archive) => {
      dialog.showMessageBox = async (_window, options) => {
        if (options.title === '恢复范围确认') { process.getBuiltinModule('fs').appendFileSync(archive, 'synthetic change'); return { response: 2, checkboxChecked: false } }
        return { response: 0, checkboxChecked: false }
      }
    }, f.archive)
    expect(await restore(f)).toMatchObject({ ok: false, code: 'SELECTION_CHANGED' })
    expect(existsSync(f.targetRoot)).toBe(false); expect(readFileSync(f.registry)).toEqual(f.registryBefore); unchanged(f, false)
  } finally { await f.ctx.cleanup() }
})

test('G07只读维护保留旧快照和残锁，不创建私有目录或审计', async () => {
  const f = await prepare()
  let resumed: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    await f.ctx.app.close()
    const legacy = join(f.ctx.tempHome.home, '.mimir/store.json.pre-restore-legacy.bak'), lock = join(f.ctx.tempHome.home, '.mimir/registry.writer-lock')
    writeFileSync(legacy, 'SYNTHETIC-LEGACY'); writeFileSync(lock, 'SYNTHETIC-RESIDUAL-LOCK')
    resumed = await electron.launch({ executablePath: process.env.MIMIR_E2E_PACKAGED, args: [...(process.env.MIMIR_E2E_PACKAGED ? [] : [mainEntry]), '--workspace-maintenance', `--user-data-dir=${f.ctx.tempHome.userData}`],
      cwd: process.env.MIMIR_E2E_PACKAGED ? f.ctx.tempHome.root : process.cwd(), env: { ...process.env, HOME: f.ctx.tempHome.home, USERPROFILE: f.ctx.tempHome.home } })
    const page = await resumed.firstWindow()
    await page.waitForFunction(() => !!window.workspaceBackupMaintenance?.doctor)
    const home = await resumed.evaluate(() => process.getBuiltinModule('os').homedir())
    expect(realpathSync(home)).toBe(realpathSync(f.ctx.tempHome.home))
    const result = await page.evaluate(async () => {
      const api = window.workspaceBackupMaintenance, before = await api.auditRecent!()
      return { view: await api.overview(), doctor: await api.doctor!(), before, after: await api.auditRecent!() }
    })
    expect(result.view).toMatchObject({ ok: true, writable: false }); expect(result.doctor.ok).toBe(true)
    if (result.doctor.ok) expect(result.doctor.checks.find(c => c.id === 'REGISTRY_SNAPSHOT_PROTECTION')).toMatchObject({ severity: 'notice', facts: { legacy: 1 } })
    expect(result.after).toEqual(result.before)
    expect(existsSync(join(f.ctx.tempHome.home, '.mimir/restore-registry-snapshots'))).toBe(false)
    expect(readFileSync(legacy, 'utf8')).toBe('SYNTHETIC-LEGACY'); expect(readFileSync(lock, 'utf8')).toBe('SYNTHETIC-RESIDUAL-LOCK')
    expect(readFileSync(f.registry)).toEqual(f.registryBefore); unchanged(f)
  } finally { if (resumed) await resumed.close(); await f.ctx.cleanup() }
})
