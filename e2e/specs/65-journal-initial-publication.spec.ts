import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createBackup } from '../../electron/workspaceBackup/packer'
import { launchApp, mainEntry, type LaunchedApp } from '../fixtures/launch'
import { attachBackupEvidence } from '../fixtures/backupEvidence'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'

function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name), key = relative(root, file)
      expect(entry.isSymbolicLink()).toBe(false)
      if (entry.isDirectory()) { result[key + '/'] = 'directory'; visit(file) }
      else result[key] = 'file:' + createHash('sha256').update(readFileSync(file)).digest('hex')
    }
  }
  visit(root); return result
}
async function reopen(ctx: LaunchedApp) {
  const app = await electron.launch({ executablePath: process.env.MIMIR_E2E_PACKAGED,
    args: [...(process.env.MIMIR_E2E_PACKAGED ? [] : [mainEntry]), '--workspace-maintenance', `--user-data-dir=${ctx.tempHome.userData}`],
    cwd: process.env.MIMIR_E2E_PACKAGED ? ctx.tempHome.root : process.cwd(),
    env: { ...process.env, HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance?.recoveryList === 'function')
  const paths = await app.evaluate(({ app }) => ({ home: process.getBuiltinModule('os').homedir(), profile: app.getPath('userData') }))
  expect(realpathSync(paths.home)).toBe(realpathSync(ctx.tempHome.home))
  expect(realpathSync(paths.profile)).toBe(realpathSync(ctx.tempHome.userData))
  return { app, page }
}
async function installCheckpoint(app: ElectronApplication, payload: { phase: 'placeholder' | 'prepared'; operations: string; checkpoint: string }) {
  await app.evaluate(({}, payload) => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path'), module = process.getBuiltinModule('module')
    const descriptors = new Map<number, string>()
    const stop = (file: string) => {
      fs.writeFileSync(payload.checkpoint, JSON.stringify({ phase: payload.phase, pid: process.pid, file }))
      process.kill(process.pid, 'SIGKILL')
      throw Error('Synthetic checkpoint termination unexpectedly returned')
    }
    const open = fs.openSync, close = fs.closeSync, rename = fs.renameSync
    fs.openSync = (...args) => {
      const fd = open(...args), file = String(args[0])
      if (args[1] === 'wx' && path.dirname(file) === payload.operations && file.endsWith('.json')) descriptors.set(fd, file)
      return fd
    }
    fs.closeSync = fd => {
      const file = descriptors.get(fd)
      descriptors.delete(fd)
      const result = close(fd)
      if (payload.phase === 'placeholder' && file && fs.statSync(file).size === 0) stop(file)
      return result
    }
    fs.renameSync = (from, to) => {
      const result = rename(from, to)
      if (payload.phase === 'prepared' && path.dirname(String(to)) === payload.operations && String(to).endsWith('.json')) {
        const record = JSON.parse(fs.readFileSync(String(to), 'utf8'))
        if (record.phase === 'prepared' && record.revision === 0) stop(String(to))
      }
      return result
    }
    module.syncBuiltinESMExports()
  }, payload)
}

for (const phase of ['placeholder', 'prepared'] as const) {
  test(`首次记录${phase}实际强退后仅只读识别，原空间和登记不变`, async ({}, info) => {
    test.setTimeout(120000)
    let source = '', sourceId = ''
    const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED,
      extraArgs: ['--workspace-maintenance'], maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true,
      transformSeed: seed => {
        source = seed.workspaces[0]!.path; sourceId = seed.workspaces[0]!.id
        return { ...seed, spaceData: { publication: '合成原始科研资料', unknown: { keep: true } } }
      }
    })
    let resumed: Awaited<ReturnType<typeof reopen>> | undefined
    try {
      writeFileSync(join(source, '合成资料.txt'), '原始字节必须保留\n')
      const archive = join(ctx.tempHome.home, 'backups/initial-publication.zip')
      mkdirSync(dirname(archive), { recursive: true })
      await createBackup({ root: source, destination: archive, stagingDir: join(ctx.tempHome.root, 'pack-temp'), assetsDb: null, sourceSpaceId: sourceId })
      const targetRoot = join(dirname(source), '尚未开始恢复'), checkpoint = join(ctx.tempHome.root, 'publication-checkpoint.json')
      const operations = join(ctx.tempHome.home, '.mimir/restore-operations'), registry = join(ctx.tempHome.home, '.mimir/store.json')
      const original = tree(source), registryBefore = readFileSync(registry), archiveBefore = readFileSync(archive)
      const child = ctx.app.process(), ownerPid = await ctx.app.evaluate(() => process.pid)
      await installCheckpoint(ctx.app, { phase, operations, checkpoint })
      const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
      const request = ctx.page.evaluate(async input => (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance.restore!(input), { archivePath: archive, targetRoot, spaceName: '合成中断恢复' })
        .then(result => ({ returned: true as const, result }), () => ({ returned: false as const }))
      const first = await Promise.race([exited.then(() => 'exit' as const), request])
      if (first !== 'exit' && first.returned) throw Error(`Expected ${phase} checkpoint was not reached; restore returned ${JSON.stringify(first.result)}`)
      expect(await exited).toBe(1)
      await request
      expect(existsSync(checkpoint), 'Exact publication checkpoint, not a timed termination').toBe(true)
      const point = JSON.parse(readFileSync(checkpoint, 'utf8'))
      expect(point).toMatchObject({ phase, pid: ownerPid })
      const metadataBefore = tree(operations), lock = join(ctx.tempHome.home, '.mimir/registry.writer-lock'), lockBefore = readFileSync(lock)
      resumed = await reopen(ctx)
      const view = await resumed.page.evaluate(() => (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance.recoveryList!())
      expect(view.writable).toBe(false)
      if (phase === 'placeholder') {
        expect(readFileSync(point.file).length).toBe(0)
        expect(view.items).toEqual([])
        expect(view.invalidRecords).toBe(readdirSync(operations).length)
        expect(view.invalidRecords).toBeGreaterThan(0)
      } else {
        const record = JSON.parse(readFileSync(point.file, 'utf8'))
        expect(record).toMatchObject({ version: 1, revision: 0, phase: 'prepared', targetRoot })
        expect(view.items).toHaveLength(1)
        expect(view.items[0]).toMatchObject({ operationId: record.id, status: 'no-output', actions: [] })
        expect(view.invalidRecords).toBe(0)
      }
      expect(tree(operations)).toEqual(metadataBefore)
      expect(readFileSync(lock)).toEqual(lockBefore)
      expect(tree(source)).toEqual(original)
      expect(readFileSync(registry)).toEqual(registryBefore)
      expect(readFileSync(archive)).toEqual(archiveBefore)
      expect(existsSync(targetRoot)).toBe(false)
      expect(readdirSync(dirname(targetRoot)).some(name => name.startsWith('.mimir-restore-staging-'))).toBe(false)
      await attachBackupEvidence(info, `initial-publication-${phase}`, { point, view, metadataPreserved: true, originalUnchanged: true, noBusinessOutput: true })
    } finally { if (resumed) await resumed.app.close(); await ctx.cleanup() }
  })
}
