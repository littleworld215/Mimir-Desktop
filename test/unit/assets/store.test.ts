import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { snapshotBeforeMigration } from '../../../electron/assets/migrations'
import { ASSETS_SCHEMA_VERSION } from '../../../electron/assets/schema'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAssetsStore, AssetsStoreManager } from '../../../electron/assets/store'
import { assetsLayout } from '../../../electron/assets/paths'
import type { AssetsStore, AssetsWriteSession, DatabaseFactory } from '../../../electron/assets/types'

const factory: DatabaseFactory = (path, options) => new Database(path, options)
let root = ''
const opened: AssetsStore[] = []
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'assets-store-test-')) })
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  rmSync(root, { recursive: true, force: true })
})
async function open(): Promise<AssetsStore> {
  const store = await openAssetsStore({ root, databaseFactory: factory })
  opened.push(store)
  return store
}
function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

describe('真实 SQLite 持久化', () => {
  it('当前schema / 15分类 / 0资产版本 / 固定连接参数', async () => {
    const { db } = await open()
    expect(db.pragma('user_version', { simple: true })).toBe(ASSETS_SCHEMA_VERSION)
    expect(db.prepare('SELECT count(*) n FROM asset_category').get()).toEqual({ n: 15 })
    expect(db.prepare('SELECT count(*) n FROM asset').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) n FROM asset_version').get()).toEqual({ n: 0 })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
  })
  it('重开不重新seed已删除分类', async () => {
    const store = await open()
    store.db.prepare("DELETE FROM asset_category WHERE code='glossary'").run()
    store.close()
    const reopened = await open()
    expect(reopened.db.prepare('SELECT count(*) n FROM asset_category').get()).toEqual({ n: 14 })
    expect(reopened.db.prepare('SELECT count(*) n FROM asset').get()).toEqual({ n: 0 })
  })
  it('损坏文件拒绝且原文件hash不变', async () => {
    const layout = assetsLayout(root)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.dbPath, 'corrupt sqlite fixture')
    const before = hash(layout.dbPath)
    await expect(open()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
    expect(hash(layout.dbPath)).toBe(before)
  })
  it('较新schema拒绝且hash不变', async () => {
    const store = await open()
    store.db.pragma('user_version = 999')
    store.close()
    const before = hash(store.layout.dbPath)
    await expect(open()).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' })
    expect(hash(store.layout.dbPath)).toBe(before)
  })
  it('缺trigger结构漂移拒绝，不自动重建', async () => {
    const store = await open()
    store.db.exec('DROP TRIGGER trg_asset_version_no_update')
    store.close()
    await expect(open()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
  })
  it('备份失败不改schema或原库hash', async () => {
    const layout = assetsLayout(root)
    mkdirSync(layout.root, { recursive: true })
    const db = factory(layout.dbPath, {})
    db.exec('PRAGMA user_version=0')
    db.close()
    const before = hash(layout.dbPath)
    await expect(openAssetsStore({ root, databaseFactory: factory, snapshot: async () => { throw new Error('backup failed') } })).rejects.toThrow()
    expect(hash(layout.dbPath)).toBe(before)
  })
  it('存量空库迁移前生成SQLite快照', async () => {
    const layout = assetsLayout(root)
    mkdirSync(layout.root, { recursive: true })
    const db = factory(layout.dbPath, {})
    db.exec('PRAGMA user_version=0')
    db.close()
    const store = await open()
    expect(store.db.pragma('user_version', { simple: true })).toBe(ASSETS_SCHEMA_VERSION)
    const backups = readdirSync(layout.backupsDir)
    expect(backups).toHaveLength(1)
    const snapshot = factory(join(layout.backupsDir, backups[0]), { readonly: true })
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(snapshot.pragma('user_version', { simple: true })).toBe(0)
    } finally { snapshot.close() }
  })
  it('快照同名冲突不覆盖已有文件', async () => {
    const store = await open()
    const clock = (): Date => new Date(0)
    const name = join(store.layout.backupsDir, `schema-${ASSETS_SCHEMA_VERSION}-0-conflict.db`)
    writeFileSync(name, 'immutable backup')
    const before = hash(name)
    await expect(snapshotBeforeMigration(store.db, store.layout.backupsDir, clock, () => 'conflict')).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(hash(name)).toBe(before)
  })
  it('第二writer拒绝，关闭后可重开且close幂等', async () => {
    const first = await open()
    await expect(open()).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    first.close()
    first.close()
    expect((await open()).db.open).toBe(true)
  })
})

describe('空间绑定与排空', () => {
  it('无空间不调用factory不建库', async () => {
    const manager = new AssetsStoreManager({ active: () => null, epoch: () => '' }, factory)
    await expect(manager.getForRequest({ workspaceId: '', spaceEpoch: '' })).rejects.toMatchObject({ code: 'NO_ACTIVE_WORKSPACE' })
  })
  it('A→B→A旧epoch拒绝，旧连接关闭', async () => {
    let active = { id: 'A', path: join(root, 'a') }
    let epoch = 'A#1'
    const manager = new AssetsStoreManager({ active: () => active, epoch: () => epoch }, factory)
    const old = await manager.getForRequest(manager.context())
    await manager.beforeSpaceSwitch()
    // 连接确实已关闭：断言失效 + 写锁已释放（同一库可被新的 writer 打开）。
    expect(() => old.assertCurrent()).toThrow('已切换')
    const reopenedWriter = await openAssetsStore({ root: join(root, 'a'), databaseFactory: factory })
    expect(reopenedWriter.db.prepare('SELECT count(*) n FROM asset').get()).toEqual({ n: 0 })
    reopenedWriter.close()
    active = { id: 'B', path: join(root, 'b') }; epoch = 'B#2'; manager.afterSpaceSwitch()
    const b = await manager.getForRequest(manager.context())
    await manager.beforeSpaceSwitch()
    expect(() => b.assertCurrent()).toThrow('已切换')
    active = { id: 'A', path: join(root, 'a') }; epoch = 'A#3'; manager.afterSpaceSwitch()
    await expect(manager.getForRequest(old.scope)).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
    const fresh = await manager.getForRequest(manager.context())
    expect(fresh.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset'))).toEqual({ n: 0 })
    await manager.close()
  })
  it('同步事务回滚，禁止Promise事务', async () => {
    const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, factory)
    const context = await manager.getForRequest(manager.context())
    expect(() => context.write(s => {
      s.run("DELETE FROM asset_category WHERE code='glossary'")
      throw new Error('rollback')
    })).toThrow('rollback')
    const readonly = factory(join(root, '.mimir', 'assets', 'assets.db'), { readonly: true, fileMustExist: true })
    expect(readonly.prepare('SELECT count(*) n FROM asset_category').get()).toEqual({ n: 15 })
    readonly.close()
    expect(() => context.write(() => Promise.resolve())).toThrow('同步')
    await manager.close()
  })
  it('异步回调无法用裸 db 跨切换写入（P0 回归）', async () => {
    const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, factory)
    let resume: () => void = () => {}
    const gate = new Promise<void>(r => { resume = r })
    let captured: AssetsWriteSession | null = null
    const task = manager.run(manager.context(), async ctx => {
      ctx.write(session => {
        captured = session
        return 0
      })
      await gate
      expect(() => captured?.run("INSERT INTO tag (name,normalized_name) VALUES ('x','x')")).toThrow()
      expect(() => ctx.assertCurrent()).toThrow('科研空间已切换')
    })
    await Promise.resolve()
    const switching = manager.beforeSpaceSwitch()
    resume()
    await expect(task).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
    await switching
    manager.afterSpaceSwitch()
    const readonly = factory(join(root, '.mimir', 'assets', 'assets.db'), { readonly: true, fileMustExist: true })
    expect(readonly.prepare('SELECT count(*) n FROM tag').get()).toEqual({ n: 0 })
    readonly.close()
    await manager.close()
  })
  it('事务结束后会话立即失效，且会话不能被带出', async () => {
    const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, factory)
    const ctx = await manager.getForRequest(manager.context())
    let leaked: AssetsWriteSession | null = null
    ctx.write(session => { leaked = session; return 0 })
    expect(() => leaked?.run("INSERT INTO tag (name,normalized_name) VALUES ('x','x')")).toThrow('写会话已结束')
    expect(() => ctx.write(session => session)).toThrow('写会话不能被带出事务')
    await manager.close()
  })
  it('开库失败自恢复：同一合法scope可重试成功（P1 EIO 注入）', async () => {
    let failNext = true
    const flaky: DatabaseFactory = (path, options) => {
      if (failNext) { failNext = false; const e = new Error('EIO') as Error & { code: string }; e.code = 'EIO'; throw e }
      return factory(path, options)
    }
    const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, flaky)
    await expect(manager.getForRequest(manager.context())).rejects.toThrow('EIO')
    const ctx = await manager.getForRequest(manager.context())
    expect(ctx.write(s => s.run("INSERT INTO tag (name,normalized_name) VALUES ('ok','ok')").changes)).toBe(1)
    await manager.close()
  })
  it('同一scope两次get返回一致上下文，关闭后两者都失效', async () => {
    const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, factory)
    const a = await manager.getForRequest(manager.context())
    const b = await manager.getForRequest(a.scope)
    expect(b.scope).toEqual(a.scope)
    a.write(s => s.run("INSERT INTO tag (name,normalized_name) VALUES ('t','t')"))
    expect(b.write(s => s.get<{ n: number }>('SELECT count(*) n FROM tag'))).toEqual({ n: 1 })
    await manager.close()
    expect(() => a.assertCurrent()).toThrow('资产连接已关闭')
    expect(() => b.write(s => s.all('SELECT 1'))).toThrow()
    await manager.close()
  })
  it('切换阻止在途任务提交并排空', async () => {
    const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, factory)
    let resume: () => void = () => {}
    const gate = new Promise<void>(resolve => { resume = resolve })
    const context = await manager.getForRequest(manager.context())
    const task = manager.run(context.scope, async ctx => {
      await gate
      ctx.write(s => s.run("DELETE FROM asset_category WHERE code='glossary'"))
    })
    await Promise.resolve()
    const switching = manager.beforeSpaceSwitch()
    resume()
    await expect(task).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
    await switching
    expect(() => context.assertCurrent()).toThrow('已切换')
    manager.afterSpaceSwitch()
  })
})
