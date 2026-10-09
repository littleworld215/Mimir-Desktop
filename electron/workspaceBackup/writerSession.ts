import { existsSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { acquireWorkspaceLock, acquireWriterLockFile } from './operationGate'

type WriterLock = ReturnType<typeof acquireWorkspaceLock>
/** 普通/维护启动共享；全局锁同时约束不同Electron profile的新版写者。 */
export class WorkspaceWriterSession {
  private registry: WriterLock
  private selected?: { workspace: WriterLock; assets?: WriterLock; maintenance: boolean }
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
    if (this.closed) throw Error('写者会话已关闭。')
    if (this.blocked) throw Error('写锁清理失败，必须先关闭会话，不能继续切换。')
    this.assertLocalRoot(root)
    const canonical = realpathSync(root)
    this.assertLocalRoot(canonical)
    if (this.selected?.workspace.root === canonical && this.selected.maintenance === maintenance) return
    // 先占新锁，失败保留原会话；不猜测残锁PID或年龄。
    const workspace = acquireWorkspaceLock(canonical)
    this.owned.add(workspace)
    let assets: WriterLock | undefined
    let releasingPrevious = false
    try {
      const assetsRoot = join(canonical, '.mimir/assets')
      if (maintenance && existsSync(assetsRoot)) {
        const actual = realpathSync(assetsRoot)
        const rel = relative(canonical, actual)
        if (rel.startsWith('..') || isAbsolute(rel) || actual !== assetsRoot) throw Error('资产目录不能使用链接或越界。')
        assets = acquireWriterLockFile(join(assetsRoot, 'assets.db.writer-lock'), canonical)
        this.owned.add(assets)
      }
      releasingPrevious = this.selected !== undefined
      if (this.selected?.assets) this.release(this.selected.assets)
      if (this.selected) this.release(this.selected.workspace)
      this.selected = { workspace, assets, maintenance }
    } catch (error) {
      if (releasingPrevious) this.blocked = true
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
  close() {
    if (this.closed) return
    this.blocked = true
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
