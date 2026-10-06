import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { assetsLayout } from './paths'
import { resolveAssetsNativeBinding } from './nativeBinding'
import { initializeSchema, inspectStore, snapshotBeforeMigration } from './migrations'
import { ASSETS_SCHEMA_VERSION } from './schema'
import { AssetsStoreError } from './types'
import type {
  AssetsContext,
  AssetsStore,
  AssetsWriteSession,
  Clock,
  DatabaseFactory,
  WorkspaceProvider
} from './types'
import type { WorkspaceRequest } from '../../shared/assetsContracts'
import { getActiveWorkspace, currentSpaceEpoch } from '../library/store'

/** 每个实体库只允许一个进程内 writer；锁文件同时拒绝第二进程 writer。 */
const writers = new Set<string>()
export const assetsDatabaseFactory: DatabaseFactory = (path, options) => {
  const binding = resolveAssetsNativeBinding({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
  return new Database(path, { ...options, nativeBinding: binding.nativeBinding })
}

/** 按需开库；所有存量预检与备份均在 writable PRAGMA / schema 修改前。 */
export async function openAssetsStore(options: {
  root: string
  databaseFactory?: DatabaseFactory
  clock?: Clock
  snapshot?: typeof snapshotBeforeMigration
}): Promise<AssetsStore> {
  const factory = options.databaseFactory ?? assetsDatabaseFactory
  const clock = options.clock ?? (() => new Date())
  const layout = assetsLayout(resolve(options.root))
  mkdirSync(layout.root, { recursive: true })
  const key = resolve(layout.dbPath).toLowerCase()
  if (writers.has(key)) throw new AssetsStoreError('WRITE_FAILED', '资产库已有写连接。')
  const lockPath = `${layout.dbPath}.writer-lock`
  let lockFd: number
  try { lockFd = openSync(lockPath, 'wx', 0o600) } catch {
    throw new AssetsStoreError('WRITE_FAILED', '资产库已被其它写者占用；请关闭其它实例。崩溃后请确认无实例再处理 writer-lock。')
  }
  writers.add(key)
  let db: Database.Database | null = null
  const release = (): void => {
    closeSync(lockFd)
    unlinkSync(lockPath)
    writers.delete(key)
  }
  try {
    const existing = existsSync(layout.dbPath)
    let version = 0
    if (existing) {
      const reader = factory(layout.dbPath, { readonly: true, fileMustExist: true })
      try { version = inspectStore(reader, factory) } finally { reader.close() }
    }
    db = factory(layout.dbPath, {})
    if (version < ASSETS_SCHEMA_VERSION) {
      mkdirSync(layout.backupsDir, { recursive: true })
      if (existing) await (options.snapshot ?? snapshotBeforeMigration)(db, layout.backupsDir, clock)
      db.pragma('foreign_keys = ON')
      initializeSchema(db, clock)
    }
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.pragma('busy_timeout = 5000')
    for (const directory of [layout.filesDir, layout.stagingDir, layout.backupsDir]) mkdirSync(directory, { recursive: true })
    const connection = db
    let closed = false
    return {
      db: connection,
      layout,
      close(): void {
        if (closed) return
        connection.close()
        closed = true
        release()
      }
    }
  } catch (error) {
    db?.close()
    release()
    if (error instanceof AssetsStoreError) throw error
    if (error instanceof Error && 'code' in error && error.code === 'NATIVE_BINDING_UNAVAILABLE') throw error
    throw new AssetsStoreError('STORE_CORRUPT', `资产库无法打开，原文件已保留：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/** 唯一连接管理器；scope 验证同时核对空间 id 与代际，不使用 spaceRoot fallback。 */
export class AssetsStoreManager {
  private store: AssetsStore | null = null
  private opening: Promise<AssetsStore> | null = null
  private bound: WorkspaceRequest | null = null
  private switching = false
  private operations = new Set<Promise<unknown>>()

  constructor(
    private readonly provider: WorkspaceProvider,
    private readonly factory: DatabaseFactory = assetsDatabaseFactory,
    private readonly clock: Clock = () => new Date()
  ) {}

  context(): WorkspaceRequest {
    const workspace = this.provider.active()
    if (workspace === null) throw new AssetsStoreError('NO_ACTIVE_WORKSPACE', '当前没有激活的科研空间。')
    return { workspaceId: workspace.id, spaceEpoch: this.provider.epoch() }
  }

  private assertScope(scope: WorkspaceRequest): void {
    const current = this.context()
    if (this.switching || scope.workspaceId !== current.workspaceId || scope.spaceEpoch !== current.spaceEpoch) {
      throw new AssetsStoreError('SPACE_CHANGED', '科研空间已切换，操作已中止，请重新获取空间上下文。')
    }
  }

  async getForRequest(scope: WorkspaceRequest): Promise<AssetsContext> {
    this.assertScope(scope)
    if (this.bound !== null && (this.bound.workspaceId !== scope.workspaceId || this.bound.spaceEpoch !== scope.spaceEpoch)) {
      await this.close()
      this.assertScope(scope)
    }
    if (this.store === null) {
      if (this.opening === null) {
        const workspace = this.provider.active()
        if (workspace === null) throw new AssetsStoreError('NO_ACTIVE_WORKSPACE', '当前没有激活的科研空间。')
        this.bound = { ...scope }
        const pending = openAssetsStore({ root: workspace.path, databaseFactory: this.factory, clock: this.clock })
        this.opening = pending
        // 开库失败必须自恢复：否则 opening 残留会让后续合法 scope 永久 SPACE_CHANGED。
        pending.catch(() => {
          if (this.opening === pending) {
            this.opening = null
            this.bound = null
          }
        })
      }
      const pending = this.opening
      try { this.store = await pending } finally { if (this.opening === pending) this.opening = null }
    }
    this.assertScope(scope)
    const store = this.store
    const captured = { ...scope }
    const assertCurrent = (): void => {
      this.assertScope(captured)
      if (this.store !== store || !store.db.open) throw new AssetsStoreError('SPACE_CHANGED', '资产连接已关闭。')
    }
    // 业务侧只拿到受限会话，永不拿到 Database；会话在事务结束后失效。
    let sessionAlive = false
    const session: AssetsWriteSession = {
      run(sql, ...params) {
        if (!sessionAlive) throw new AssetsStoreError('SPACE_CHANGED', '写会话已结束，不能继续写入。')
        assertCurrent()
        const result = store.db.prepare(sql).run(...(params as never[]))
        return { changes: result.changes }
      },
      get<T>(sql: string, ...params: unknown[]): T | undefined {
        if (!sessionAlive) throw new AssetsStoreError('SPACE_CHANGED', '写会话已结束，不能继续读取。')
        assertCurrent()
        return store.db.prepare(sql).get(...(params as never[])) as T | undefined
      },
      all<T>(sql: string, ...params: unknown[]): T[] {
        if (!sessionAlive) throw new AssetsStoreError('SPACE_CHANGED', '写会话已结束，不能继续读取。')
        assertCurrent()
        return store.db.prepare(sql).all(...(params as never[])) as T[]
      }
    }
    const context: AssetsContext = {
      scope: captured,
      layout: store.layout,
      assertCurrent,
      write: <T>(operation: (session: AssetsWriteSession) => T): T => {
        assertCurrent()
        return store.db.transaction(() => {
          sessionAlive = true
          try {
            const value = operation(session)
            if (value !== null && typeof value === 'object' && 'then' in value) {
              throw new AssetsStoreError('BAD_REQUEST', '资产事务必须同步，不允许跨 await。')
            }
            // 回调把会话本身返回出去也属于逃逸：事务一结束它就失效，但显式拒绝更明确。
            if (value === session) throw new AssetsStoreError('BAD_REQUEST', '写会话不能被带出事务。')
            assertCurrent()
            return value
          } finally {
            sessionAlive = false
          }
        })()
      }
    }
    return context
  }

  /** 跟踪异步文件任务；切换先阻断提交，再排空任务，最后关连接。 */
  async run<T>(scope: WorkspaceRequest, operation: (context: AssetsContext) => Promise<T>): Promise<T> {
    this.assertScope(scope)
    const pending = (async (): Promise<T> => {
      const context = await this.getForRequest(scope)
      const result = await operation(context)
      context.assertCurrent()
      return result
    })()
    this.operations.add(pending)
    try { return await pending } finally { this.operations.delete(pending) }
  }

  async beforeSpaceSwitch(): Promise<void> {
    this.switching = true
    await Promise.allSettled([...this.operations])
    await this.close()
  }

  /** 即便切换失败也恢复入口；旧连接已关闭，当前可信空间可重新按需开库。 */
  afterSpaceSwitch(): void { this.switching = false }

  async close(): Promise<void> {
    if (this.opening !== null) {
      const pending = this.opening
      try { this.store = await pending } catch { /* 开库失败：不留下残留状态。 */ }
      if (this.opening === pending) this.opening = null
    }
    this.store?.close()
    this.store = null
    this.bound = null
  }
}

export const assetsStoreManager = new AssetsStoreManager({ active: getActiveWorkspace, epoch: currentSpaceEpoch })
