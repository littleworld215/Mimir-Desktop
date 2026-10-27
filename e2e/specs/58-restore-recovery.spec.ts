import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createBackup } from '../../electron/workspaceBackup/packer'
import { launchApp, mainEntry, type LaunchedApp } from '../fixtures/launch'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
function contents(root: string) {
  const files: Record<string, string> = {}
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (!entry.name.endsWith('writer-lock')) files[relative(root, file)] = hash(file)
  } }
  walk(root); return files
}
async function prepare() {
  let source = '', sourceId = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true, extraArgs: ['--workspace-maintenance'], transformSeed: seed => {
    source = seed.workspaces[0].path; sourceId = seed.workspaces[0].id
    return { ...seed, spaceData: { 'g05-synthetic': '合成科研资料', unknown: { original: source } } }
  } })
  writeFileSync(join(source, '合成资料.txt'), 'G05原资料必须保留\n')
  const archive = join(ctx.tempHome.home, 'backups/g05.zip')
  mkdirSync(dirname(archive), { recursive: true })
  await createBackup({ root: source, destination: archive, stagingDir: join(ctx.tempHome.root, 'pack-temp'), assetsDb: null, sourceSpaceId: sourceId })
  const registry = join(ctx.tempHome.home, '.mimir/store.json'), targetRoot = join(dirname(source), 'G05新空间')
  return { ctx, child: ctx.app.process(), ownerPid: await ctx.app.evaluate(() => process.pid), source, archive, registry, targetRoot, sourceBefore: contents(source), archiveBefore: hash(archive), registryBefore: JSON.parse(readFileSync(registry, 'utf8')) }
}
async function reopen(ctx: LaunchedApp) {
  const app = await electron.launch({ executablePath: process.env.MIMIR_E2E_PACKAGED,
    args: [...(process.env.MIMIR_E2E_PACKAGED ? [] : [mainEntry]), '--workspace-maintenance', `--user-data-dir=${ctx.tempHome.userData}`],
    cwd: process.env.MIMIR_E2E_PACKAGED ? ctx.tempHome.root : process.cwd(),
    env: { ...process.env, HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' } })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance?.recoveryList === 'function')
  const actual = await app.evaluate(({ app }) => ({ home: process.getBuiltinModule('os').homedir(), profile: app.getPath('userData') }))
  expect(realpathSync(actual.home)).toBe(realpathSync(ctx.tempHome.home))
  expect(realpathSync(actual.profile)).toBe(realpathSync(ctx.tempHome.userData))
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
  return { app, page }
}
async function installFault(app: ElectronApplication, payload: { registry: string; operations: string; phase?: string; stagingStore?: boolean; checkpoint?: string }) {
  await app.evaluate(({ }, payload) => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path'), module = process.getBuiltinModule('module')
    const stop = () => {
      if (payload.checkpoint) fs.writeFileSync(payload.checkpoint, JSON.stringify({ pid: process.pid, phase: payload.phase }))
      process.kill(process.pid, 'SIGKILL')
      throw Error('Synthetic checkpoint termination returned unexpectedly')
    }
    const rename = fs.renameSync, unlink = fs.unlinkSync
    fs.renameSync = (from, to) => {
      if (payload.stagingStore && String(to).includes('.mimir-restore-staging-') && path.basename(String(to)) === 'store.json') throw Error('G05 synthetic remap failure')
      if (!payload.phase && String(to) === payload.registry) throw Error('G05 synthetic register failure')
      const value = rename(from, to)
      if (payload.phase && path.dirname(String(to)) === payload.operations && String(to).endsWith('.json')) {
        const record = JSON.parse(fs.readFileSync(String(to), 'utf8'))
        if ((payload.phase === 'extracting-created' && record.phase === 'extracting' && record.rootIdentity) || record.phase === payload.phase) stop()
      }
      return value
    }
    fs.unlinkSync = file => {
      const value = unlink(file)
      if (payload.phase === 'prepared' && path.dirname(String(file)) === payload.operations && path.basename(String(file)).startsWith('.tmp-')) {
        const names = fs.readdirSync(payload.operations).filter(n => n.endsWith('.json'))
        if (names.some(name => JSON.parse(fs.readFileSync(path.join(payload.operations, name), 'utf8')).phase === 'prepared')) stop()
      }
      return value
    }
    module.syncBuiltinESMExports()
  }, payload)
}

test('暂存已清理但完成记录未写入时中断，重启能识别且不重复删除', async () => {
  test.setTimeout(120_000)
  const f = await prepare(), { ctx } = f
  let resumed: Awaited<ReturnType<typeof reopen>> | undefined
  try {
    await installFault(ctx.app, { registry: f.registry, operations: join(ctx.tempHome.home, '.mimir/restore-operations'), stagingStore: true })
    const outcome = await ctx.page.evaluate(async request => window.workspaceBackupMaintenance.restore!(request), { archivePath: f.archive, targetRoot: f.targetRoot, spaceName: 'G05清理中断' })
    expect(outcome.ok).toBe(false)
    const record = savedOperation(ctx)
    expect(existsSync(record.stagingRoot)).toBe(true)
    await ctx.app.evaluate(({ dialog }, root) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      const fs = process.getBuiltinModule('fs'), rm = fs.rmSync
      fs.rmSync = (path, options) => { const result = rm(path, options); if (String(path).replace(/\\/g, '/') === root.replace(/\\/g, '/')) { process.kill(process.pid, 'SIGKILL'); throw Error('Synthetic cleanup termination returned') }; return result }
      process.getBuiltinModule('module').syncBuiltinESMExports()
    }, record.stagingRoot)
    const exit = new Promise<number | null>(resolve => f.child.once('exit', code => resolve(code)))
    const action = ctx.page.evaluate(async operationId => window.workspaceBackupMaintenance.recoveryAction!({ operationId, action: 'cleanup' }), record.id).catch(() => null)
    expect(await exit).toBe(1); await action
    expect(existsSync(record.stagingRoot)).toBe(false)
    const interrupted = savedOperation(ctx)
    expect(interrupted.phase).toBe('cleaning')
    resumed = await reopen(ctx)
    const list = await resumed.page.evaluate(() => window.workspaceBackupMaintenance.recoveryList!())
    expect(list.writable).toBe(false); expect(list.items[0].status).toBe('cleaned')
    expect(list.items[0].actions).toEqual([])
    await resumed.app.close(); resumed = undefined
    await test.info().attach('cleanup-synthetic-lock-proof', { body: JSON.stringify(await quarantineSyntheticLocks(ctx, interrupted, f.child, f.ownerPid)), contentType: 'application/json' })
    resumed = await reopen(ctx)
    expect((await resumed.page.evaluate(() => window.workspaceBackupMaintenance.recoveryList!())).items[0].status).toBe('cleaned')
    expect(existsSync(f.targetRoot)).toBe(false)
    expect(JSON.parse(readFileSync(f.registry, 'utf8'))).toEqual(f.registryBefore)
    unchanged(f)
  } finally { if (resumed) await resumed.app.close(); await ctx.cleanup() }
})
function savedOperation(ctx: LaunchedApp) {
  const dir = join(ctx.tempHome.home, '.mimir/restore-operations'), names = readdirSync(dir).filter(n => n.endsWith('.json'))
  expect(names).toHaveLength(1)
  return JSON.parse(readFileSync(join(dir, names[0]), 'utf8'))
}
function unchanged(f: Awaited<ReturnType<typeof prepare>>) {
  expect(contents(f.source)).toEqual(f.sourceBefore)
  expect(hash(f.archive)).toBe(f.archiveBefore)
  const after = JSON.parse(readFileSync(f.registry, 'utf8'))
  for (const key of Object.keys(f.registryBefore).filter(k => k !== 'workspaces:list')) expect(after[key]).toEqual(f.registryBefore[key])
}
async function quarantineSyntheticLocks(ctx: LaunchedApp, record: ReturnType<typeof savedOperation>, child: ReturnType<ElectronApplication['process']>, ownerPid: number) {
  expect(child.exitCode).toBe(1)
  await expect.poll(() => { try { process.kill(ownerPid, 0); return false } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' } }).toBe(true)
  const output = join(ctx.tempHome.root, 'synthetic-lock-quarantine')
  mkdirSync(output)
  const files = [join(ctx.tempHome.home, '.mimir/registry.writer-lock'), join(existsSync(record.targetRoot) ? record.targetRoot : record.stagingRoot, '.mimir/workspace.writer-lock')]
  const proof: Array<{ file: string; sha256: string }> = []
  for (const [index, file] of files.entries()) {
    if (!existsSync(file)) continue
    const credential = JSON.parse(readFileSync(file, 'utf8'))
    expect(credential.pid).toBe(ownerPid)
    expect(relative(ctx.tempHome.root, file).startsWith('..')).toBe(false)
    const sha256 = hash(file)
    renameSync(file, join(output, `${index}.json`))
    expect(hash(join(output, `${index}.json`))).toBe(sha256)
    proof.push({ file: relative(ctx.tempHome.root, file), sha256 })
  }
  return { syntheticOnly: true, productDidNotUnlock: true, oldProcessExited: true, proof }
}

test('登记失败后真实重启，从界面复核同一目录和UUID，不重复追加', async () => {
  test.setTimeout(120_000)
  const f = await prepare(), { ctx } = f
  let restarted: Awaited<ReturnType<typeof reopen>> | undefined
  try {
    await installFault(ctx.app, { registry: f.registry, operations: join(ctx.tempHome.home, '.mimir/restore-operations') })
    const outcome = await ctx.page.evaluate(async request => window.workspaceBackupMaintenance.restore!(request), { archivePath: f.archive, targetRoot: f.targetRoot, spaceName: 'G05登记重试' })
    expect(outcome).toMatchObject({ ok: false, code: 'REGISTER_FAILED' })
    const record = savedOperation(ctx), before = contents(f.targetRoot)
    await ctx.app.close()
    restarted = await reopen(ctx)
    const panel = restarted.page.getByRole('region', { name: '中断恢复记录' })
    await panel.getByRole('button', { name: '复核并完成登记' }).click()
    await expect(panel.getByRole('status').filter({ hasText: '已完成同一空间的登记' })).toBeVisible()
    const registry = JSON.parse(readFileSync(f.registry, 'utf8'))
    expect(registry['workspaces:list']).toHaveLength(2)
    expect(registry['workspaces:list'][1]).toMatchObject({ id: record.spaceId, path: f.targetRoot })
    expect(contents(f.targetRoot)).toEqual(before)
    const snapshots = readdirSync(join(ctx.tempHome.home, '.mimir/restore-registry-snapshots')).filter(n => n.startsWith('store.json.pre-restore-'))
    const duplicate = await restarted.page.evaluate(async operationId => window.workspaceBackupMaintenance.recoveryAction!({ operationId, action: 'register' }), record.id)
    expect(duplicate).toMatchObject({ ok: true, alreadyRegistered: true, spaceId: record.spaceId })
    expect(readdirSync(join(ctx.tempHome.home, '.mimir/restore-registry-snapshots')).filter(n => n.startsWith('store.json.pre-restore-'))).toEqual(snapshots)
    unchanged(f)
  } finally { if (restarted) await restarted.app.close(); await ctx.cleanup() }
})

for (const phase of ['prepared', 'extracting-created', 'verifying', 'publishing', 'published', 'registering', 'registered'] as const) {
  test(`真实进程中断 ${phase}：只读识别、残锁保留及受控收尾`, async () => {
    test.setTimeout(120_000)
    const f = await prepare(), { ctx } = f
    let resumed: Awaited<ReturnType<typeof reopen>> | undefined
    try {
      const checkpoint = join(ctx.tempHome.root, 'checkpoint.json')
      await installFault(ctx.app, { registry: f.registry, operations: join(ctx.tempHome.home, '.mimir/restore-operations'), phase, checkpoint })
      const exit = new Promise<number | null>(resolve => f.child.once('exit', code => resolve(code)))
      const request = ctx.page.evaluate(async request => window.workspaceBackupMaintenance.restore!(request), { archivePath: f.archive, targetRoot: f.targetRoot, spaceName: `G05中断-${phase}` }).catch(() => null)
      expect(await exit).toBe(1)
      await request
      expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toEqual({ pid: f.ownerPid, phase })
      const record = savedOperation(ctx), lock = join(ctx.tempHome.home, '.mimir/registry.writer-lock'), lockHash = hash(lock)
      expect(record.phase).toBe(phase === 'extracting-created' ? 'extracting' : phase)
      resumed = await reopen(ctx)
      await expect(resumed.page.getByText('维护写锁尚未取得，当前为只读查看。', { exact: false })).toBeVisible()
      const readOnly = await resumed.page.evaluate(() => window.workspaceBackupMaintenance.recoveryList!())
      expect(readOnly.writable).toBe(false); expect(readOnly.items).toHaveLength(1); expect(readOnly.invalidRecords).toBe(0)
      expect(readOnly.items[0].operationId).toBe(record.id)
      expect(hash(lock)).toBe(lockHash)
      if (phase === 'prepared') {
        const control = join(ctx.tempHome.home, '.mimir'), beforeDoctor = contents(control)
        expect((await resumed.page.evaluate(() => window.workspaceBackupMaintenance.doctor!())).ok).toBe(true)
        expect(contents(control)).toEqual(beforeDoctor)
      }
      const denied = await resumed.page.evaluate(async operationId => window.workspaceBackupMaintenance.recoveryAction!({ operationId, action: 'cleanup' }), record.id)
      expect(denied).toMatchObject({ ok: false, code: 'LOCK_UNAVAILABLE' })
      expect(hash(lock)).toBe(lockHash)
      await resumed.app.close(); resumed = undefined
      // Existing protocol requires manual handling of stale locks. This step acts only on these synthetic locks.
      const quarantine = await quarantineSyntheticLocks(ctx, record, f.child, f.ownerPid)
      await test.info().attach(`synthetic-lock-proof-${phase}`, { body: JSON.stringify(quarantine), contentType: 'application/json' })
      resumed = await reopen(ctx)
      const current = await resumed.page.evaluate(() => window.workspaceBackupMaintenance.recoveryList!())
      expect(current.writable).toBe(true); expect(current.items).toHaveLength(1)
      if (['published', 'registering', 'registered'].includes(phase)) {
        const result = await resumed.page.evaluate(async operationId => window.workspaceBackupMaintenance.recoveryAction!({ operationId, action: 'register' }), record.id)
        expect(result).toMatchObject({ ok: true, spaceId: record.spaceId, alreadyRegistered: phase === 'registered' })
        expect(JSON.parse(readFileSync(f.registry, 'utf8'))['workspaces:list']).toHaveLength(2)
      } else if (phase === 'verifying' || phase === 'publishing') {
        const panel = resumed.page.getByRole('region', { name: '中断恢复记录' })
        await panel.getByRole('button', { name: '核对并清理暂存…' }).click()
        await expect(panel.getByRole('status').filter({ hasText: '已保留本次恢复暂存' })).toBeVisible()
        expect(existsSync(record.stagingRoot)).toBe(true)
        await resumed.app.evaluate(({ dialog }) => { dialog.showMessageBox = async (_window, options) => {
          if (options?.title !== '清理本次恢复暂存' || options.defaultId !== 0 || options.cancelId !== 0) throw Error('Unexpected approval dialog')
          return { response: 1, checkboxChecked: false }
        } })
        await panel.getByRole('button', { name: '核对并清理暂存…' }).click()
        await expect(panel.getByRole('status').filter({ hasText: '已清理本次恢复暂存' })).toBeVisible()
        expect(existsSync(record.stagingRoot)).toBe(false)
        expect(existsSync(f.targetRoot)).toBe(false)
      } else {
        expect(current.items[0].status).toBe(phase === 'prepared' ? 'no-output' : 'interrupted')
        expect(current.items[0].actions).toEqual([])
        if (phase === 'extracting-created') expect(existsSync(record.stagingRoot)).toBe(true)
      }
      unchanged(f)
    } finally { if (resumed) await resumed.app.close(); await ctx.cleanup() }
  })
}
