import type Database from 'better-sqlite3'
import type { AssetsErrorCode, WorkspaceRequest } from '../../shared/assetsContracts'
import type { AssetsLayout } from './paths'

export type DatabaseFactory = (path: string, options: Database.Options) => Database.Database
export type Clock = () => Date

/** 可跨 IPC 映射的资产存储错误（`details` 与 `AssetsResult` 的失败分支同形）。 */
export class AssetsStoreError extends Error {
  constructor(
    readonly code: AssetsErrorCode,
    message: string,
    readonly details?: { currentRevision?: number; currentVersionId?: number | null }
  ) {
    super(message)
    this.name = 'AssetsStoreError'
  }
}

/** 底层连接；只由 manager 持有，业务侧不得拿到。 */
export interface AssetsStore {
  readonly db: Database.Database
  readonly layout: AssetsLayout
  close(): void
}

/**
 * 受限同步写会话：只暴露「立即执行」的 SQL 入口，不暴露 Database / Statement。
 *
 * 为什么不给 db：异步文件任务跨 `await` 后仍持有句柄，就可能在空间切换排空期间
 * 直接 `db.prepare(...).run()` 写进旧空间（已实证）。会话对象在事务结束后即失效，
 * 且每次执行都重新核验 scope，跨 await 持有也无法再用。
 */
export interface AssetsWriteSession {
  run(sql: string, ...params: unknown[]): { changes: number }
  get<T>(sql: string, ...params: unknown[]): T | undefined
  all<T>(sql: string, ...params: unknown[]): T[]
}

/**
 * 业务侧可见的资产上下文：**不继承**底层 AssetsStore，不公开 db / close。
 * 写入唯一入口是 {@link AssetsContext.write}，每次写入都核验空间 scope 与连接状态。
 */
export interface AssetsContext {
  readonly scope: WorkspaceRequest
  readonly layout: AssetsLayout
  /** 校验当前空间与连接仍然有效；失效抛 SPACE_CHANGED。 */
  assertCurrent(): void
  /** 受守卫的同步事务写入口；会话只在本次调用内有效。 */
  write<T>(operation: (session: AssetsWriteSession) => T): T
}

export interface WorkspaceProvider {
  active(): { id: string; path: string } | null
  epoch(): string
}
