import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MaintenanceRecoveryItem, MaintenanceRecoveryList, MaintenanceRecoveryStatus } from '../../shared/workspaceBackupContracts'
import { checkRestoredAssetsIntegrity, type AssetsIntegrityOptions } from './assetsIntegrity'
import { createRestoreSteps } from './restoreAdapter'
import { RestoreError } from './restoreContracts'
import { assertRestoreDirectory, assertRestoreIdentity, fingerprintRestoredRoot, restoreRootIdentity, sameRestorePath } from './restoreFingerprint'
import { RestoreJournal, type RestoreOperationRecord } from './restoreJournal'
import { runMaintenanceRestore, type MaintenanceRestoreDeps, type RestoreRequest } from './restoreMain'
import type { RestoreInput, RestoreOutcome, RestoreSteps } from './restoreRunner'
import { appendWorkspaceRecord, buildRegistryAppendInput, type RegistryAppendInput } from './registryAppend'
import { cleanupStagingRoot } from './stagingRoot'
import { readRegistryOverview } from './registryView'

type Lease = { release(): void; migrate?(next: string): void }
export interface RestoreRecoveryOptions {
  homeDir: string
  assertUsable(): void
  lockRoot(root: string): Lease
  assetsIntegrityOptions?: AssetsIntegrityOptions
  append?(input: RegistryAppendInput): { appended: boolean }
}
export interface RecoveryCleanupView { spaceName: string; entries: number; totalBytes: number }
const blocked = () => new RestoreError('CONTROL_BLOCKED', '该记录目前不允许此操作，资料已保留，请重新读取。')
const changed = () => new RestoreError('RECHECK_FAILED', '恢复资料或操作记录已变化，未继续登记或清理。')
function pathExists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw changed() }
}

/** 只按私有记录中的固定身份处理，不接受来自渲染层的恢复/清理路径。 */
export class RestoreRecovery {
  private readonly journal: RestoreJournal
  private readonly locks = new Map<string, { lease: Lease; token: string }>()
  private busy = false
  constructor(private readonly options: RestoreRecoveryOptions) { this.journal = new RestoreJournal(options.homeDir) }
  private writable(): boolean {
    try { this.options.assertUsable(); return !this.busy } catch { return false }
  }
  private assertWritable(): void {
    try { this.options.assertUsable() } catch { throw new RestoreError('LOCK_UNAVAILABLE', '维护写锁不可用，当前仅可只读查看。') }
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.assertWritable()
    if (this.busy) throw blocked()
    this.busy = true
    try { return await fn() } finally { this.busy = false }
  }
  private registryState(record: RestoreOperationRecord): boolean {
    try {
      readRegistryOverview(this.options.homeDir)
      const registry = JSON.parse(readFileSync(join(this.options.homeDir, '.mimir/store.json'), 'utf8'))
      if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw Error('registry')
      const spaces: unknown = registry['workspaces:list'] ?? []
      if (!Array.isArray(spaces) || spaces.some(s => !s || typeof s !== 'object' || Array.isArray(s))) throw Error('registry')
      const matches = spaces.filter(s => s.id === record.spaceId || (typeof s.path === 'string' && sameRestorePath(s.path, record.targetRoot)))
      if (!matches.length) return false
      if (matches.length !== 1 || matches[0].id !== record.spaceId || typeof matches[0].path !== 'string' || !sameRestorePath(matches[0].path, record.targetRoot)) throw Error('conflict')
      return true
    } catch { throw new RestoreError('REGISTRY_INVALID', '空间登记无效或与恢复记录冲突，未修改注册表。') }
  }
  private locate(record: RestoreOperationRecord): 'staging' | 'published' | 'missing' {
    assertRestoreIdentity(record.parentRoot, record.parentIdentity)
    const staged = pathExists(record.stagingRoot), published = pathExists(record.targetRoot)
    if (staged && published) throw changed()
    if (!staged && !published) return 'missing'
    if (!record.rootIdentity) throw changed()
    assertRestoreIdentity(staged ? record.stagingRoot : record.targetRoot, record.rootIdentity)
    return staged ? 'staging' : 'published'
  }
  async list(cursor?: string): Promise<MaintenanceRecoveryList> {
    const { records, invalidRecords, truncated, nextCursor } = this.journal.scan(cursor), writable = this.writable()
    const items = records.map(record => {
      let status: MaintenanceRecoveryStatus = 'blocked'
      try {
        const place = this.locate(record)
        if (place === 'missing') status = record.phase === 'cleaned' || record.phase === 'cleaning' ? 'cleaned' : 'no-output'
        else if (place === 'published') {
          if (this.registryState(record)) status = 'registered'
          else if (record.phase !== 'registered' && record.fingerprint) status = 'pending-registration'
        } else if (record.phase !== 'cleaned') status = record.fingerprint ? 'staging-retained' : 'interrupted'
      } catch { /* blocked records remain visible; listing never changes or removes them */ }
      const item: MaintenanceRecoveryItem = {
        operationId: record.id, spaceName: record.spaceName, createdAt: record.createdAt, phase: record.phase,
        status, entries: record.entries ?? 0, totalBytes: record.totalBytes ?? 0,
        actions: writable ? status === 'pending-registration' ? ['register'] : status === 'staging-retained' ? ['cleanup'] : [] : []
      }
      return item
    })
    return { ok: true, writable, items, invalidRecords, truncated, ...(nextCursor ? { nextCursor } : {}) }
  }
  private assertRecord(record: RestoreOperationRecord): void {
    const fresh = this.journal.read(record.id)
    if (fresh.revision !== record.revision || JSON.stringify(fresh) !== JSON.stringify(record)) throw changed()
    this.assertWritable()
  }
  private async verify(record: RestoreOperationRecord, root: string): Promise<void> {
    this.assertRecord(record)
    if (!record.rootIdentity || !record.fingerprint) throw changed()
    assertRestoreIdentity(record.parentRoot, record.parentIdentity)
    const current = await fingerprintRestoredRoot(root, record.rootIdentity)
    if (current.digest !== record.fingerprint.digest || current.entries !== record.fingerprint.entries || current.totalBytes !== record.fingerprint.totalBytes) throw changed()
    this.assertRecord(record)
    assertRestoreIdentity(record.parentRoot, record.parentIdentity)
    this.assertHeldLock(record, root)
  }
  private rememberLock(id: string, root: string, lease: Lease): Lease {
    try {
      const credential = this.readLock(root)
      if (typeof credential.token !== 'string' || credential.pid !== process.pid) throw Error('lock')
      this.locks.set(id, { lease, token: credential.token })
      return lease
    } catch { throw new RestoreError('LOCK_UNAVAILABLE', '恢复目录写锁无法核验。') }
  }
  private readLock(root: string): { token: string; pid: number } {
    assertRestoreDirectory(join(root, '.mimir'))
    const file = join(root, '.mimir/workspace.writer-lock'), before = lstatSync(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) throw changed()
    const credential = JSON.parse(readFileSync(file, 'utf8')), after = lstatSync(file, { bigint: true })
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || typeof credential.token !== 'string' || typeof credential.pid !== 'number') throw changed()
    return { token: credential.token, pid: credential.pid }
  }
  private lock(record: RestoreOperationRecord, root: string): Lease {
    this.assertWritable()
    assertRestoreDirectory(join(root, '.mimir'))
    if (pathExists(join(root, '.mimir/assets/assets.db.writer-lock'))) throw new RestoreError('LOCK_UNAVAILABLE', '资产目录仍有写锁，未修改或移除现有锁。')
    const path = join(root, '.mimir/workspace.writer-lock'), saved = this.locks.get(record.id)
    if (saved && pathExists(path)) {
      try {
        const current = this.readLock(root)
        if (current.token !== saved.token || current.pid !== process.pid) throw Error('lock changed')
        return saved.lease
      } catch { throw new RestoreError('LOCK_UNAVAILABLE', '恢复目录写锁已改变，未删除任何锁。') }
    }
    this.locks.delete(record.id)
    if (pathExists(path)) throw new RestoreError('LOCK_UNAVAILABLE', '恢复目录仍有写锁；请按锁处理规约确认，不会按时间或PID移除。')
    try { return this.rememberLock(record.id, root, this.options.lockRoot(root)) }
    catch { throw new RestoreError('LOCK_UNAVAILABLE', '未取得恢复目录写锁，未修改资料。') }
  }
  private release(id: string, lease: Lease): void {
    lease.release()
    this.locks.delete(id)
  }
  private assertHeldLock(record: RestoreOperationRecord, root: string): void {
    this.assertWritable()
    try {
      if (pathExists(join(root, '.mimir/assets/assets.db.writer-lock'))) throw Error('assets writer')
      const saved = this.locks.get(record.id), current = this.readLock(root)
      if (!saved || current.token !== saved.token || current.pid !== process.pid) throw Error('workspace writer changed')
    } catch { throw new RestoreError('LOCK_UNAVAILABLE', '恢复目录写锁状态已变化，资料与现有锁均保留。') }
  }
  async register(id: string): Promise<{ spaceId: string; alreadyRegistered: boolean }> {
    return this.exclusive(async () => {
      let record = this.journal.read(id)
      if (this.locate(record) !== 'published' || !record.fingerprint) throw blocked()
      const alreadyRegistered = this.registryState(record)
      if (record.phase === 'registered' && !alreadyRegistered) throw blocked()
      const lease = this.lock(record, record.targetRoot)
      let failed = false
      try {
        await this.verify(record, record.targetRoot)
        const input: RestoreInput = { archivePath: '', targetRoot: record.targetRoot, stagingRoot: record.stagingRoot, homeDir: this.options.homeDir, spaceName: record.spaceName, oldRoot: '' }
        // No prepareAssets: a published space is inspected read-only, never migrated here.
        const checks = createRestoreSteps({ checkAssetsIntegrity: path => checkRestoredAssetsIntegrity(path, this.options.assetsIntegrityOptions) })
        await checks.recheck(input, record.targetRoot)
        await this.verify(record, record.targetRoot)
        if (!alreadyRegistered) {
          record = this.journal.save(record, { phase: 'registering' })
          this.assertHeldLock(record, record.targetRoot)
          const append = this.options.append ?? (value => appendWorkspaceRecord(this.options.homeDir, value))
          append(buildRegistryAppendInput({ id: record.spaceId, name: record.spaceName, path: record.targetRoot }, () => record.createdAt))
        }
        if (!this.registryState(record)) throw new RestoreError('REGISTER_FAILED', '登记结果尚未确认，恢复资料已保留。')
        this.assertHeldLock(record, record.targetRoot)
        this.journal.save(record, { phase: 'registered', errorCode: undefined })
        return { spaceId: record.spaceId, alreadyRegistered }
      } catch (error) { failed = true; throw error }
      finally { try { this.release(id, lease) } catch { if (!failed) throw new RestoreError('LOCK_UNAVAILABLE', '恢复目录锁释放未完成，请核对维护记录。') } }
    })
  }
  async cleanup(id: string, confirm: (view: RecoveryCleanupView) => Promise<boolean>): Promise<boolean> {
    return this.exclusive(async () => {
      let record = this.journal.read(id)
      if (this.locate(record) !== 'staging' || !record.fingerprint) throw blocked()
      const lease = this.lock(record, record.stagingRoot)
      let failed = false
      try {
        await this.verify(record, record.stagingRoot)
        if (!await confirm({ spaceName: record.spaceName, entries: record.fingerprint.entries, totalBytes: record.fingerprint.totalBytes })) return false
        await this.verify(record, record.stagingRoot)
        record = this.journal.save(record, { phase: 'cleaning' })
        this.assertHeldLock(record, record.stagingRoot)
        assertRestoreIdentity(record.parentRoot, record.parentIdentity)
        assertRestoreIdentity(record.stagingRoot, record.rootIdentity!)
        this.release(id, lease)
        cleanupStagingRoot(record.stagingRoot, { identity: record.rootIdentity })
        this.journal.save(record, { phase: 'cleaned', errorCode: undefined })
        return true
      } catch (error) { failed = true; throw error }
      finally { if (this.locks.has(id)) { try { this.release(id, lease) } catch { if (!failed) throw new RestoreError('LOCK_UNAVAILABLE', '暂存目录锁释放未完成，请核对维护记录。') } } }
    })
  }
  async run(request: RestoreRequest, deps: MaintenanceRestoreDeps): Promise<RestoreOutcome> {
    let record: RestoreOperationRecord | undefined
    const fail = (code: 'CONTROL_BLOCKED' | 'LOCK_UNAVAILABLE' | 'RECHECK_FAILED'): RestoreOutcome => ({ stage: 'failed', failure: { stage: 'inspecting', code, retryable: true, detail: '恢复操作未完成，资料已保留，请重新读取维护记录。' }, result: null, remap: null, cleanup: null, finishedAt: new Date().toISOString() })
    try {
      return await this.exclusive(async () => {
        if (!sameRestorePath(deps.homeDir, this.options.homeDir)) return fail('LOCK_UNAVAILABLE')
        const update = (patch: Partial<RestoreOperationRecord>) => { if (!record) throw changed(); record = this.journal.save(record, patch) }
        const decorate = (steps: RestoreSteps, _input: RestoreInput): RestoreSteps => ({
          ...steps,
          inspect: async input => {
            update({ phase: 'inspecting' })
            const plan = await steps.inspect(input)
            update({ entries: plan.entries, totalBytes: plan.totalBytes })
            return plan
          },
          createStaging: async input => {
            update({ phase: 'extracting' })
            const root = await steps.createStaging(input)
            if (!record || !sameRestorePath(root, record.stagingRoot)) throw changed()
            update({ rootIdentity: restoreRootIdentity(root) })
            return root
          },
          extract: async (input, root) => {
            const count = await steps.extract(input, root)
            update({ phase: 'verifying', fingerprint: await fingerprintRestoredRoot(root, record!.rootIdentity) })
            return count
          },
          recheck: async (input, root) => {
            await steps.recheck(input, root)
            update({ phase: 'verified', fingerprint: await fingerprintRestoredRoot(root, record!.rootIdentity) })
          },
          publish: async (input, root) => {
            await this.verify(record!, root)
            update({ phase: 'publishing' })
            await steps.publish(input, root)
            update({ phase: 'published' })
          },
          register: async (_input, spaceId) => {
            if (!record || spaceId !== record.spaceId) throw changed()
            this.lock(record, record.targetRoot)
            await this.verify(record, record.targetRoot)
            update({ phase: 'registering' })
            this.assertHeldLock(record!, record!.targetRoot)
            const append = this.options.append ?? (value => appendWorkspaceRecord(this.options.homeDir, value))
            const result = append(buildRegistryAppendInput({ id: record.spaceId, name: record.spaceName, path: record.targetRoot }, () => record!.createdAt))
            if (!this.registryState(record)) throw new RestoreError('REGISTER_FAILED', '登记结果尚未确认。')
            update({ phase: 'registered' })
            return result
          },
          // Failed extraction is retained for explicit, fingerprint-bound cleanup; never prefix-delete it.
          cleanupStaging: async () => {}
        })
        const outcome = await runMaintenanceRestore(request, {
          ...deps,
          lockStagingRoot: root => {
            if (!record) throw changed()
            return this.rememberLock(record.id, root, deps.lockStagingRoot(root))
          },
          beginOperation: () => {
            this.assertWritable()
            record = this.journal.create(request.targetRoot, request.spaceName)
            return { id: record.id, spaceId: record.spaceId, decorate }
          }
        })
        if (record && outcome.failure) {
          if (record.rootIdentity && this.locate(record) === 'staging') {
            try { update({ phase: 'interrupted', fingerprint: await fingerprintRestoredRoot(record.stagingRoot, record.rootIdentity) }) }
            catch { /* no seal means no cleanup permission */ }
          }
          update({ errorCode: outcome.failure.code })
        }
        return outcome
      })
    } catch (error) {
      return fail(error instanceof RestoreError && error.code === 'CONTROL_BLOCKED' ? 'CONTROL_BLOCKED' : error instanceof RestoreError && error.code === 'LOCK_UNAVAILABLE' ? 'LOCK_UNAVAILABLE' : 'RECHECK_FAILED')
    }
  }
}
