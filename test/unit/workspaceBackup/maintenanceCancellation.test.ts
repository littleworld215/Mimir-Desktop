import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaintenanceTaskManager } from '../../../electron/workspaceBackup/maintenanceTask'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { runRestore, type RestoreSteps } from '../../../electron/workspaceBackup/restoreRunner'
import { RestoreRecovery } from '../../../electron/workspaceBackup/restoreRecovery'
import { acquireStagingLock } from '../../../electron/workspaceBackup/maintenanceRestoreHandler'
import { buildDoctorReport } from '../../../electron/workspaceBackup/doctorReport'
import { runSpaceBackup } from '../../../electron/workspaceBackup/backupService'
import { buildDoctorHandler } from '../../../electron/workspaceBackup/maintenanceDoctorHandler'
import { maintenanceCheckpoint } from '../../../electron/workspaceBackup/maintenanceTask'

const roots: string[] = [], leases: Array<{ release(): void }> = []
afterEach(() => {
  for (const lease of leases.splice(0)) { try { lease.release() } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g06-cancel-')); roots.push(root)
  const source = join(root, 'source'), stage = join(root, 'packing'), destination = join(root, 'archive.zip')
  mkdirSync(source); writeFileSync(join(source, '合成资料.txt'), Buffer.alloc(4 * 1024 * 1024, 67))
  return { root, source, stage, destination, request: { root: source, destination, stagingDir: stage, assetsDb: null } }
}
it('real backup cancellation leaves no published archive or owned partial files', async () => {
  const f = fixture(), tasks = new MaintenanceTaskManager()
  const work = tasks.run('backup', async () => { await createBackup(f.request); return { ok: true } })
  expect(tasks.cancel({ taskId: tasks.current!.taskId }).ok).toBe(true)
  expect(await work).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(existsSync(f.destination)).toBe(false)
  expect(!existsSync(f.stage) || readdirSync(f.stage).length === 0).toBe(true)
  // Windows open-handle probes: original can be renamed/removed after cancellation.
  rmSync(join(f.source, '合成资料.txt'))
})
it('backup publication announces an uncancellable commit and still produces a valid result', async () => {
  const f = fixture(); let observed = false
  const tasks = new MaintenanceTaskManager(progress => {
    if (progress.state === 'committing') {
      observed = true
      expect(tasks.cancel({ taskId: progress.taskId })).toMatchObject({ ok: false, code: 'NOT_CANCELLABLE' })
    }
  })
  expect(await tasks.run('backup', async () => { await createBackup(f.request); return { ok: true } })).toEqual({ ok: true })
  expect(observed).toBe(true)
  expect(existsSync(f.destination)).toBe(true)
})
it('restore runner does not publish when cancellation arrives at the last safe boundary', async () => {
  const tasks = new MaintenanceTaskManager(); let published = false
  const steps = {
    inspect: async () => ({ targetRoot: 'C:/synthetic/new', entries: 0, totalBytes: 0 }),
    createStaging: async () => 'C:/synthetic/.mimir-restore-test', extract: async () => 0,
    remap: async () => ({ found: [], rewritten: [] }),
    recheck: async () => { tasks.cancel({ taskId: tasks.current!.taskId }) },
    publish: async () => { published = true }, register: async () => ({ appended: true }), cleanupStaging: async () => {}
  } as unknown as RestoreSteps
  await tasks.run('restore', async () => {
    const result = await runRestore({ archivePath: 'C:/synthetic/a.zip', targetRoot: 'C:/synthetic/new', stagingRoot: 'C:/synthetic/.mimir-restore-test', homeDir: 'C:/synthetic/home', spaceName: '合成', oldRoot: '' }, steps)
    return { ok: result.failure === null, code: result.failure?.code }
  })
  expect(published).toBe(false)
})
it('发布前完整复核仍可取消，只有首次发布副作用前进入提交段', async () => {
  const tasks = new MaintenanceTaskManager(); let prepared = false, published = false
  const steps = {
    inspect: async () => ({ targetRoot: 'C:/synthetic/new', entries: 0, totalBytes: 0 }),
    createStaging: async () => 'C:/synthetic/.mimir-restore-test', extract: async () => 0,
    remap: async () => ({ found: [], rewritten: [] }), recheck: async () => {},
    preparePublish: async () => { prepared = true; expect(tasks.current!.cancellable).toBe(true); tasks.cancel({ taskId: tasks.current!.taskId }) },
    publish: async () => { published = true }, register: async () => ({ appended: true }), cleanupStaging: async () => {}
  } as unknown as RestoreSteps
  await tasks.run('restore', async () => {
    const outcome = await runRestore({ archivePath: 'C:/synthetic/a.zip', targetRoot: 'C:/synthetic/new', stagingRoot: 'C:/synthetic/.mimir-restore-test', homeDir: 'C:/synthetic/home', spaceName: '合成', oldRoot: '' }, steps)
    return { ok: outcome.failure === null, code: outcome.failure?.code }
  })
  expect(prepared).toBe(true)
  expect(published).toBe(false)
})
it('real journaled restore cancels before publication, cleans only its own staging and preserves registry', async () => {
  const f = fixture(); await createBackup(f.request)
  const homeDir = join(f.root, 'home'), targetRoot = join(f.root, 'restored')
  mkdirSync(join(homeDir, '.mimir'), { recursive: true })
  const registry = join(homeDir, '.mimir/store.json'), original = JSON.stringify({ 'workspaces:list': [], untouched: 'keep' })
  writeFileSync(registry, original)
  const unrelated = join(f.root, '.mimir-restore-unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep.txt'), 'keep')
  const tasks = new MaintenanceTaskManager()
  const lockRoot = (root: string) => { const lock = acquireStagingLock(root); leases.push(lock); return lock }
  const recovery = new RestoreRecovery({ homeDir, assertUsable: () => {}, lockRoot })
  const result = await tasks.run('restore', async () => {
    const outcome = await recovery.run({ archivePath: f.destination, targetRoot, spaceName: '合成恢复' }, {
      homeDir, session: { assertUsable: () => {} }, lockStagingRoot: lockRoot,
      adapter: { prepareAssets: async () => { tasks.cancel({ taskId: tasks.current!.taskId }) } }
    })
    return { ok: outcome.failure === null, code: outcome.failure?.code }
  })
  expect(result).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(existsSync(targetRoot)).toBe(false)
  expect(readFileSync(registry, 'utf8')).toBe(original)
  const records = readdirSync(join(homeDir, '.mimir/restore-operations'))
  const record = JSON.parse(readFileSync(join(homeDir, '.mimir/restore-operations', records[0]), 'utf8'))
  expect(record.phase).toBe('cleaned')
  expect(existsSync(record.stagingRoot)).toBe(false)
  expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('keep')
})
it('doctor cancellation does not downgrade to warning and scan the remaining archives', async () => {
  const tasks = new MaintenanceTaskManager(); let checked = 0
  const outcome = await tasks.run('doctor', async () => {
    await buildDoctorReport({ home: 'synthetic', readRegistry: () => [], listArchives: async () => [{ path: 'first', name: 'first.zip' }, { path: 'second', name: 'second.zip' }],
      verifyArchive: async () => { checked++; tasks.cancel({ taskId: tasks.current!.taskId }) }, resolveSpaces: () => [], scanResiduals: () => [] })
    return { ok: true }
  })
  expect(outcome).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(checked).toBe(1)
})

it('failed lock release after cancellation is a cleanup failure, not a completed cancellation', async () => {
  const f = fixture(), tasks = new MaintenanceTaskManager()
  const result = await tasks.run('backup', () => runSpaceBackup({ spaceId: 'synthetic' }, {
    home: f.root, resolveSpaces: () => [{ id: 'synthetic', name: '合成', path: f.source }],
    acquireSpaceLock: () => ({ release: () => { throw Error('synthetic release failure') } }), writeAudit: () => {},
    createBackup: async () => { tasks.cancel({ taskId: tasks.current!.taskId }); await maintenanceCheckpoint(); throw Error('unreachable') }
  }))
  expect(result).toMatchObject({ ok: false, code: 'TASK_CLEANUP_FAILED' })
})
it('doctor cancelled after report return must not append a success audit', async () => {
  const tasks = new MaintenanceTaskManager(); let wrote = false
  const handler = buildDoctorHandler({ homeDir: 'synthetic', writeAudit: () => { wrote = true },
    buildReport: async () => {
      tasks.cancel({ taskId: tasks.current!.taskId })
      return { at: new Date().toISOString(), checks: [], summary: { ok: 0, notice: 0, warning: 0, error: 0 } }
    }
  })
  expect(await tasks.run('doctor', () => handler.doctor())).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(wrote).toBe(false)
})
