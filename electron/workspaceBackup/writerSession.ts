import { existsSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { acquireWorkspaceLock, acquireWriterLockFile } from './operationGate'

type WriterLock = ReturnType<typeof acquireWorkspaceLock>
type Selection = { workspace: WriterLock; assets?: WriterLock; maintenance: boolean }
/** 普通/维护启动共享；全局锁同时约束不同Electron profile的新版写者。 */
export class WorkspaceWriterSession {
  private registry: WriterLock
  private selected?: Selection
  private pending?: symbol
  private closed = false
  private blocked = false
  private owned = new Set<WriterLock>()
  constructor(home: string, private readonly assertLocalRoot: (root: string) => void) {
    if (typeof assertLocalRoot !== 'function') throw Error('必须先核查本机磁盘，不能推测网络映射盘。')
    assertLocalRoot(home)
    const canonicalHome = realpathSync(home)
    assertLocalRoot(canonicalHome)
    this.registry = acquireWorkspaceLock(canonicalHome, 'registry.writer-lock')
    this.owned.add(this.registry)
  }
  select(root: string, maintenance = false) {
    this.prepareSelection(root, maintenance).commit()
  }
  assertUsable() {
    if (this.closed || this.blocked) throw Error('写者会话失效，已阻止继续写入。')
  }
  assertRegistryHome(home: string) {
    this.assertUsable()
    if (this.registry.root !== realpathSync(home)) throw Error('当前注册表未持有对应写锁。')
  }
  assertSelectedRoot(root: string) {
    this.assertUsable()
    if (this.pending || this.selected?.workspace.root !== realpathSync(root)) throw Error('当前空间未持有对应写锁。')
  }
  /** 指针/缓存事务成功后才提交；失败回滚期间仍持有原空间锁。 */
  prepareSelection(root: string, maintenance = false) {
    if (this.closed) throw Error('写者会话已关闭。')
    if (this.blocked) throw Error('写锁清理失败，必须先关闭会话，不能继续切换。')
    if (this.pending) throw Error('空间锁事务尚未结束，不能嵌套切换。')
    this.assertLocalRoot(root)
    const canonical = realpathSync(root)
    this.assertLocalRoot(canonical)
    const previous = this.selected
    const token = Symbol('selection')
    if (previous?.workspace.root === canonical && previous.maintenance === maintenance) {
      this.pending = token
      return this.transaction(token, previous, previous)
    }
    // 先占新锁，失败保留原会话；不猜测残锁PID或年龄。
    const workspace = acquireWorkspaceLock(canonical)
    this.owned.add(workspace)
    let assets: WriterLock | undefined
    try {
      const assetsRoot = join(canonical, '.mimir/assets')
      if (maintenance && existsSync(assetsRoot)) {
        const actual = realpathSync(assetsRoot)
        const rel = relative(canonical, actual)
        if (rel.startsWith('..') || isAbsolute(rel) || actual !== assetsRoot) throw Error('资产目录不能使用链接或越界。')
        assets = acquireWriterLockFile(join(assetsRoot, 'assets.db.writer-lock'), canonical)
        this.owned.add(assets)
      }
      this.pending = token
      return this.transaction(token, previous, { workspace, assets, maintenance })
    } catch (error) {
      const cleanupErrors: unknown[] = []
      for (const lock of [assets, workspace]) {
        if (!lock) continue
        try { this.release(lock) } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      }
      if (cleanupErrors.length > 0) {
        this.blocked = true
        throw new AggregateError([error, ...cleanupErrors], '写锁回滚清理失败；会话保留待清理锁。')
      }
      throw error
    }
  }
  private transaction(token: symbol, previous: Selection | undefined, next: Selection) {
    let settled: 'commit' | 'rollback' | undefined
    const check = (action: 'commit' | 'rollback') => {
      if (settled === action) return false
      if (settled || this.closed || this.blocked || this.pending !== token) throw Error('空间锁事务已失效。')
      return true
    }
    const releaseNext = () => {
      if (previous === next) return
      const errors: unknown[] = []
      for (const lock of [next.assets, next.workspace]) {
        if (!lock) continue
        try { this.release(lock) } catch (error) { errors.push(error) }
      }
      if (errors.length) {
        this.blocked = true
        throw new AggregateError(errors, '新空间锁回滚失败；会话保留待清理锁。')
      }
    }
    return {
      commit: () => {
        if (!check('commit')) return
        try {
          if (previous !== next) {
            if (previous?.assets) this.release(previous.assets)
            if (previous) this.release(previous.workspace)
          }
          this.selected = next
          settled = 'commit'
        } catch (error) {
          this.blocked = true
          try { releaseNext() } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], '旧锁提交与新锁清理失败；会话阻断。')
          }
          throw error
        } finally { this.pending = undefined }
      },
      rollback: () => {
        if (!check('rollback')) return
        try { releaseNext(); settled = 'rollback' }
        finally { this.pending = undefined }
      }
    }
  }
  close() {
    if (this.closed) return
    this.blocked = true
    this.pending = undefined
    const errors: unknown[] = []
    for (const lock of this.owned) {
      if (lock === this.registry) continue
      try { this.release(lock) } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) {
      this.blocked = true
      throw new AggregateError(errors, '空间锁清理失败；注册表锁继续保持。')
    }
    this.release(this.registry)
    this.closed = true
  }
  private release(lock: WriterLock) {
    lock.release()
    this.owned.delete(lock)
  }
}
