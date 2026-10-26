import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { appendWorkspaceRecord, buildRegistryAppendInput } from '../../../electron/workspaceBackup/registryAppend'
import { acquireStagingLock } from '../../../electron/workspaceBackup/maintenanceRestoreHandler'
import { cleanupStagingRoot } from '../../../electron/workspaceBackup/stagingRoot'
import { RestoreError } from '../../../electron/workspaceBackup/restoreContracts'
import type { RestoreAdapterOptions } from '../../../electron/workspaceBackup/restoreAdapter'
import { MaintenanceTaskManager } from '../../../electron/workspaceBackup/maintenanceTask'

const fault = vi.hoisted(() => ({ assetLockAtRegisterCommit: false, denyJournal: false }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const path = await import('node:path')
  return { ...fs, renameSync: (from: string, to: string) => {
    if (fault.denyJournal && to.includes('restore-operations')) throw Object.assign(Error('synthetic journal write failure'), { code: 'ENOSPC' })
    fs.renameSync(from, to)
    if (fault.assetLockAtRegisterCommit && to.includes('restore-operations') && to.endsWith('.json')) {
      const record = JSON.parse(fs.readFileSync(to, 'utf8'))
      if (record.phase === 'registering') {
        fault.assetLockAtRegisterCommit = false
        fs.writeFileSync(path.join(record.targetRoot, '.mimir/assets/assets.db.writer-lock'), 'late-assets-lock')
      }
    }
  } }
})

const roots: string[] = []
const leases: Array<{ release(): void }> = []
afterEach(() => {
  fault.assetLockAtRegisterCommit = false
  fault.denyJournal = false
  for (const lease of leases.splice(0)) { try { lease.release() } catch { /* negative lock-replacement probe */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-g05-'))
  roots.push(root)
  const homeDir = join(root, 'home'), source = join(root, 'source'), targetRoot = join(root, 'new-space')
  mkdirSync(join(homeDir, '.mimir'), { recursive: true })
  mkdirSync(join(source, '.mimir/assets'), { recursive: true })
  const registry = join(homeDir, '.mimir/store.json')
  const original = { 'workspaces:list': [{ id: 'original', name: '原空间', path: source }], activeWorkspaceId: 'original', defaultWorkspaceId: 'original', settings: { key: 'synthetic-secret' }, unknown: [1, 2] }
  writeFileSync(registry, JSON.stringify(original))
  writeFileSync(join(source, '.mimir/store.json'), JSON.stringify({ notes: '合成科研正文', unknown: { value: source } }))
  writeFileSync(join(source, 'data.txt'), '合成结果\n')
  const archivePath = join(root, 'backup.zip')
  await createBackup({ root: source, destination: archivePath, stagingDir: join(root, 'pack-staging'), assetsDb: null })
  const sourceHash = digest(join(source, 'data.txt')), archiveHash = digest(archivePath)
  const modulePath = join(process.cwd(), 'electron/workspaceBackup/restoreRecovery.ts')
  const mod = await import(/* @vite-ignore */ modulePath).catch(() => ({}))
  expect(mod.RestoreRecovery, 'G05 recovery coordinator must exist').toBeTypeOf('function')
  let writable = true, failAppend = false, failAfterAppend = false
  const lockRoot = (path: string) => { const lease = acquireStagingLock(path); leases.push(lease); return lease }
  const options = {
    homeDir, assertUsable: () => { if (!writable) throw Error('blocked') }, lockRoot,
    append: (input: Parameters<typeof appendWorkspaceRecord>[1]) => {
      if (failAppend) throw new RestoreError('REGISTER_FAILED', 'synthetic append fault')
      const result = appendWorkspaceRecord(homeDir, input)
      if (failAfterAppend) throw new RestoreError('REGISTER_FAILED', 'synthetic receipt fault')
      return result
    }
  }
  const fresh = () => new mod.RestoreRecovery(options)
  const recovery = fresh()
  const run = (adapter: RestoreAdapterOptions = {}) => recovery.run({ archivePath, targetRoot, spaceName: '恢复资料' }, { session: { assertUsable: options.assertUsable }, homeDir, lockStagingRoot: lockRoot, adapter })
  const records = () => readdirSync(join(homeDir, '.mimir/restore-operations')).filter(file => file.endsWith('.json'))
  const recordFile = () => join(homeDir, '.mimir/restore-operations', records()[0])
  const record = () => JSON.parse(readFileSync(recordFile(), 'utf8'))
  const release = () => { for (const lease of leases.splice(0)) lease.release() }
  const unchanged = () => { expect(digest(join(source, 'data.txt'))).toBe(sourceHash); if (existsSync(archivePath)) expect(digest(archivePath)).toBe(archiveHash) }
  return { root, homeDir, source, targetRoot, archivePath, registry, original, recovery, fresh, run, recordFile, record, release, unchanged,
    setWritable: (v: boolean) => { writable = v }, setFailAppend: (v: boolean) => { failAppend = v }, setFailAfterAppend: (v: boolean) => { failAfterAppend = v } }
}
it('取消后的目录定位失败须报告收尾失败并保留两处现场', async () => {
  const f = await fixture(), tasks = new MaintenanceTaskManager()
  let moved = ''
  const result = await tasks.run('restore', async () => {
    const outcome = await f.run({ prepareAssets: async root => {
      tasks.cancel({ taskId: tasks.current!.taskId })
      moved = root + '-preserved'; renameSync(root, moved); mkdirSync(root)
    } })
    return { ok: outcome.failure === null, code: outcome.failure?.code }
  })
  expect(result).toMatchObject({ ok: false, code: 'STAGING_CLEANUP_FAILED' })
  expect(existsSync(moved)).toBe(true)
  expect(existsSync(f.record().stagingRoot)).toBe(true)
  f.unchanged()
})
it('取消收尾的定位或错误记录无法落盘也不得覆盖收尾失败结论', async () => {
  const f = await fixture(), tasks = new MaintenanceTaskManager()
  let retained = ''
  const result = await tasks.run('restore', async () => {
    const outcome = await f.run({ prepareAssets: async root => {
      retained = root
      tasks.cancel({ taskId: tasks.current!.taskId }); fault.denyJournal = true
    } })
    return { ok: outcome.failure === null, code: outcome.failure?.code }
  })
  fault.denyJournal = false
  expect(result).toMatchObject({ ok: false, code: 'STAGING_CLEANUP_FAILED' })
  expect(existsSync(retained)).toBe(true)
  f.unchanged()
})
async function pending() {
  const f = await fixture()
  f.setFailAppend(true)
  const outcome = await f.run()
  expect(outcome.failure?.code).toBe('REGISTER_FAILED')
  f.setFailAppend(false)
  return f
}
async function interrupted() {
  const f = await fixture()
  const outcome = await f.run({ prepareAssets: async () => { throw new RestoreError('RECHECK_FAILED', 'synthetic recheck fault') } })
  expect(outcome.failure?.code).toBe('RECHECK_FAILED')
  return f
}

it('仅路径命中而UUID不同不算幂等登记，原注册表不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-g05-conflict-')); roots.push(root)
  mkdirSync(join(root, '.mimir'))
  const file = join(root, '.mimir/store.json'), path = join(root, 'space')
  const raw = JSON.stringify({ 'workspaces:list': [{ id: 'existing', name: '原空间', path }] })
  writeFileSync(file, raw)
  expect(() => appendWorkspaceRecord(root, buildRegistryAppendInput({ id: 'different', name: '恢复', path }))).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(raw)
})

it('仅UUID命中而路径不同不算幂等登记', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-g05-conflict-')); roots.push(root)
  mkdirSync(join(root, '.mimir'))
  writeFileSync(join(root, '.mimir/store.json'), JSON.stringify({ 'workspaces:list': [{ id: 'same', name: '原', path: join(root, 'old') }] }))
  expect(() => appendWorkspaceRecord(root, buildRegistryAppendInput({ id: 'same', name: '恢复', path: join(root, 'other') }))).toThrow()
})

it('清理不凭暂存前缀授予所有权', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-g05-owner-')); roots.push(root)
  const foreign = join(root, '.mimir-restore-staging-user-data')
  mkdirSync(foreign); writeFileSync(join(foreign, 'keep.txt'), '用户资料')
  expect(() => cleanupStagingRoot(foreign)).toThrow()
  expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('用户资料')
})

it('没有操作记录时只读列举，不创建目录', async () => {
  const f = await fixture()
  expect((await f.recovery.list()).items).toEqual([])
  expect(existsSync(join(f.homeDir, '.mimir/restore-operations'))).toBe(false)
})

it('注册失败后跨实例只登记同一UUID和目录，不再依赖原包或重复解压', async () => {
  const f = await pending(), saved = f.record()
  expect((await f.recovery.list()).items[0].status).toBe('pending-registration')
  const content = digest(join(f.targetRoot, '.mimir/store.json'))
  f.release(); unlinkSync(f.archivePath)
  const receipt = await f.fresh().register(saved.id)
  expect(receipt.spaceId).toBe(saved.spaceId)
  expect(receipt.alreadyRegistered).toBe(false)
  const current = JSON.parse(readFileSync(f.registry, 'utf8'))
  expect(current['workspaces:list']).toHaveLength(2)
  expect(current['workspaces:list'][1]).toMatchObject({ id: saved.spaceId, path: f.targetRoot })
  expect(current.settings).toEqual(f.original.settings)
  expect(current.activeWorkspaceId).toBe('original'); expect(current.defaultWorkspaceId).toBe('original')
  expect(digest(join(f.targetRoot, '.mimir/store.json'))).toBe(content)
  f.unchanged()
})

it('重复登记不重复追加，不新增保护快照', async () => {
  const f = await pending(); f.release()
  const id = f.record().id, fresh = f.fresh()
  await fresh.register(id)
  const before = readdirSync(join(f.homeDir, '.mimir/restore-registry-snapshots')).filter(n => n.startsWith('store.json.pre-restore-'))
  expect((await fresh.register(id)).alreadyRegistered).toBe(true)
  expect(readdirSync(join(f.homeDir, '.mimir/restore-registry-snapshots')).filter(n => n.startsWith('store.json.pre-restore-'))).toEqual(before)
  expect(JSON.parse(readFileSync(f.registry, 'utf8'))['workspaces:list']).toHaveLength(2)
})

it('登记已经落盘但回执失败，重启识别已登记，不再追加', async () => {
  const f = await fixture(); f.setFailAfterAppend(true)
  expect((await f.run()).failure?.code).toBe('REGISTER_FAILED')
  f.release(); f.setFailAfterAppend(false)
  expect((await f.fresh().list()).items[0].status).toBe('registered')
  const raw = readFileSync(f.registry, 'utf8')
  expect((await f.fresh().register(f.record().id)).alreadyRegistered).toBe(true)
  expect(readFileSync(f.registry, 'utf8')).toBe(raw)
})

it('发布后阶段记录未更新，也凭原创建根身份识别待登记目录', async () => {
  const f = await pending(), saved = f.record(); f.release()
  saved.phase = 'publishing'; saved.revision += 1
  writeFileSync(f.recordFile(), JSON.stringify(saved))
  expect((await f.fresh().list()).items[0].status).toBe('pending-registration')
  expect((await f.fresh().register(saved.id)).spaceId).toBe(saved.spaceId)
})

it('内容后来变化时拒绝登记，不动新空间和注册表', async () => {
  const f = await pending(); f.release()
  const before = readFileSync(f.registry, 'utf8')
  writeFileSync(join(f.targetRoot, 'late.txt'), '新增资料')
  await expect(f.fresh().register(f.record().id)).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(f.registry, 'utf8')).toBe(before)
  expect(readFileSync(join(f.targetRoot, 'late.txt'), 'utf8')).toBe('新增资料')
})

it('内容相同但目录被替换时拒绝登记', async () => {
  const f = await pending(); f.release()
  renameSync(f.targetRoot, f.targetRoot + '-owned')
  cpSync(f.targetRoot + '-owned', f.targetRoot, { recursive: true })
  await expect(f.fresh().register(f.record().id)).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(existsSync(f.targetRoot)).toBe(true)
})

it('已发布空间没有清理入口，即使用户愿意确认也不删除', async () => {
  const f = await pending(); f.release()
  let prompted = false
  await expect(f.fresh().cleanup(f.record().id, async () => { prompted = true; return true })).rejects.toMatchObject({ code: 'CONTROL_BLOCKED' })
  expect(prompted).toBe(false); expect(existsSync(f.targetRoot)).toBe(true)
})

it('中断暂存保留，取消确认不删除', async () => {
  const f = await interrupted(), record = f.record()
  expect((await f.recovery.list()).items[0].status).toBe('staging-retained')
  expect(await f.recovery.cleanup(record.id, async () => false)).toBe(false)
  expect(existsSync(record.stagingRoot)).toBe(true)
  f.unchanged()
})

it('显式确认后只清理同身份同摘要的本任务暂存', async () => {
  const f = await interrupted(), record = f.record()
  f.release()
  expect(await f.fresh().cleanup(record.id, async view => { expect(view.spaceName).toBe('恢复资料'); return true })).toBe(true)
  expect(existsSync(record.stagingRoot)).toBe(false)
  expect((await f.fresh().list()).items[0].status).toBe('cleaned')
  expect(JSON.parse(readFileSync(f.registry, 'utf8'))).toEqual(f.original)
  f.unchanged()
})

it('确认期间新增资料，拒绝删除', async () => {
  const f = await interrupted(), record = f.record()
  await expect(f.recovery.cleanup(record.id, async () => { writeFileSync(join(record.stagingRoot, 'late.txt'), '不能丢失'); return true })).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(join(record.stagingRoot, 'late.txt'), 'utf8')).toBe('不能丢失')
})

it('确认期间替换根目录，拒绝删除替代目录和原暂存', async () => {
  const f = await interrupted(), record = f.record()
  await expect(f.recovery.cleanup(record.id, async () => {
    renameSync(record.stagingRoot, record.stagingRoot + '-original')
    mkdirSync(record.stagingRoot); writeFileSync(join(record.stagingRoot, 'keep.txt'), '保留')
    return true
  })).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(existsSync(record.stagingRoot + '-original')).toBe(true)
  expect(readFileSync(join(record.stagingRoot, 'keep.txt'), 'utf8')).toBe('保留')
})

it('暂存内后来加入junction时拒绝清理，不碰外部文件', async () => {
  const f = await interrupted(), record = f.record(), outside = join(f.root, 'outside')
  mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), '外部资料')
  symlinkSync(outside, join(record.stagingRoot, 'jump'), 'junction')
  await expect(f.recovery.cleanup(record.id, async () => true)).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('外部资料')
})

it('损坏记录显示阻断计数，不重置为空库，不暴露原始内容', async () => {
  const f = await pending(), file = f.recordFile()
  writeFileSync(file, '{synthetic-secret')
  const result = await f.fresh().list()
  expect(result.invalidRecords).toBe(1)
  expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  expect(readFileSync(file, 'utf8')).toBe('{synthetic-secret')
})

it('维护写锁失效时只读可见，登记继续阻断', async () => {
  const f = await pending(); f.setWritable(false)
  const result = await f.fresh().list()
  expect(result.writable).toBe(false); expect(result.items).toHaveLength(1)
  await expect(f.fresh().register(f.record().id)).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' })
})

it('另一实例仍持有空间锁时不删除锁、不登记', async () => {
  const f = await pending(), lock = join(f.targetRoot, '.mimir/workspace.writer-lock'), raw = readFileSync(lock, 'utf8')
  await expect(f.fresh().register(f.record().id)).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' })
  expect(readFileSync(lock, 'utf8')).toBe(raw)
})

it('旧写者资产锁仍存在时拒绝登记，不删除资产锁', async () => {
  const f = await pending(); f.release()
  const lock = join(f.targetRoot, '.mimir/assets/assets.db.writer-lock')
  writeFileSync(lock, 'foreign-lock')
  await expect(f.fresh().register(f.record().id)).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' })
  expect(readFileSync(lock, 'utf8')).toBe('foreign-lock')
})

it('首次恢复发布后出现资产锁，也不能直接登记', async () => {
  const f = await fixture()
  const outcome = await f.recovery.run({ archivePath: f.archivePath, targetRoot: f.targetRoot, spaceName: '恢复资料' }, {
    session: { assertUsable() {} }, homeDir: f.homeDir,
    lockStagingRoot: root => {
      const lease = acquireStagingLock(root); leases.push(lease)
      return { release: () => lease.release(), migrate: next => {
        lease.migrate?.(next)
        writeFileSync(join(f.targetRoot, '.mimir/assets/assets.db.writer-lock'), 'foreign-after-publish')
      } }
    }
  })
  expect(outcome.failure?.code).toBe('LOCK_UNAVAILABLE')
  expect(JSON.parse(readFileSync(f.registry, 'utf8'))).toEqual(f.original)
  expect(readFileSync(join(f.targetRoot, '.mimir/assets/assets.db.writer-lock'), 'utf8')).toBe('foreign-after-publish')
})

it('确认期间新增资产写锁，清理拒绝并保留该锁及暂存资料', async () => {
  const f = await interrupted(), record = f.record(), lock = join(record.stagingRoot, '.mimir/assets/assets.db.writer-lock')
  await expect(f.recovery.cleanup(record.id, async () => { writeFileSync(lock, 'late-assets-lock'); return true })).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' })
  expect(readFileSync(lock, 'utf8')).toBe('late-assets-lock')
  expect(existsSync(join(record.stagingRoot, 'data.txt'))).toBe(true)
})

it('异步复核完成到登记提交间新增资产锁，登记拒绝', async () => {
  const f = await pending(); f.release()
  fault.assetLockAtRegisterCommit = true
  await expect(f.fresh().register(f.record().id)).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' })
  expect(readFileSync(join(f.targetRoot, '.mimir/assets/assets.db.writer-lock'), 'utf8')).toBe('late-assets-lock')
  expect(JSON.parse(readFileSync(f.registry, 'utf8'))).toEqual(f.original)
})

it.each([51, 1001])('%i条较新终态记录不能遮住旧待登记任务，所有页面可达', async historyCount => {
  const f = await pending(), original = f.record()
  f.release()
  for (let i = 1; i <= historyCount; i++) {
    const id = `00000000-0000-0000-0000-${i.toString(16).padStart(12, '0')}`, targetRoot = join(f.root, `finished-${i}`)
    const record = { ...original, id, spaceId: id, targetRoot, stagingRoot: join(f.root, `.mimir-restore-staging-${id}`), phase: 'cleaned', updatedAt: '2099-01-01T00:00:00.000Z' }
    delete record.rootIdentity; delete record.fingerprint
    writeFileSync(join(f.homeDir, '.mimir/restore-operations', `${id}.json`), JSON.stringify(record))
  }
  const recovery = f.fresh(), seen: string[] = []
  let cursor: string | undefined, found = false, pages = 0
  do {
    const page = await recovery.list(cursor)
    expect(page.items.length).toBeLessThanOrEqual(50)
    seen.push(...page.items.map((item: { operationId: string }) => item.operationId))
    found ||= page.items.some((item: { operationId: string; status: string }) => item.operationId === original.id && item.status === 'pending-registration')
    cursor = page.nextCursor; pages += 1
    if (!cursor) break
  } while (pages < 30)
  expect(found).toBe(true)
  expect(new Set(seen).size).toBe(historyCount + 1)
  expect((await recovery.register(original.id)).spaceId).toBe(original.spaceId)
})

it('确认期间操作记录被改写时拒绝删除', async () => {
  const f = await interrupted(), record = f.record()
  await expect(f.recovery.cleanup(record.id, async () => {
    writeFileSync(f.recordFile(), JSON.stringify({ ...f.record(), revision: record.revision + 1 }))
    return true
  })).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(existsSync(record.stagingRoot)).toBe(true)
})

it('中断暂存缺少完整摘要时仅保留，不提供清理动作', async () => {
  const f = await interrupted(), record = f.record()
  delete record.fingerprint
  writeFileSync(f.recordFile(), JSON.stringify(record))
  const item = (await f.fresh().list()).items[0]
  expect(item.status).toBe('interrupted'); expect(item.actions).toEqual([])
  await expect(f.fresh().cleanup(record.id, async () => true)).rejects.toMatchObject({ code: 'CONTROL_BLOCKED' })
})

it('未知操作ID及路径穿越请求不读取任意文件', async () => {
  const f = await fixture()
  await expect(f.recovery.register('../../store')).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  await expect(f.recovery.cleanup('not-a-uuid', async () => true)).rejects.toMatchObject({ code: 'INVALID_TARGET' })
})

it('操作目录是junction时拒绝读写，外部资料保留', async () => {
  const f = await fixture(), outside = join(f.root, 'outside-journal')
  mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), '保留')
  symlinkSync(outside, join(f.homeDir, '.mimir/restore-operations'), 'junction')
  expect((await f.run()).stage).toBe('failed')
  expect(existsSync(f.targetRoot)).toBe(false)
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('保留')
})

it('操作记录无法落盘时不创建恢复产物', async () => {
  const f = await fixture()
  writeFileSync(join(f.homeDir, '.mimir/restore-operations'), 'block directory')
  expect((await f.run()).stage).toBe('failed')
  expect(existsSync(f.targetRoot)).toBe(false)
  expect(readdirSync(f.root).filter(n => n.startsWith('.mimir-restore-staging-'))).toEqual([])
})
