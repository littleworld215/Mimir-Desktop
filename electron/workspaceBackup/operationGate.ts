import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

export interface OperationScope { id: string; epoch: string; root: string }
interface Lease { scope: OperationScope; active: boolean }
export class WorkspaceOperationGate {
  private context = new AsyncLocalStorage<Lease>()
  private controlContext = new AsyncLocalStorage<{ active: boolean; deadline: number }>()
  private controlTail: Promise<unknown> = Promise.resolve()
  private controlRequests = 0
  private controlBlocked = false
  private externallyPaused = false
  private pending = new Set<Promise<unknown>>()
  private accepting = true
  private failedDuringDrain = false
  get pendingCount() { return this.pending.size }
  current(): OperationScope | undefined {
    const control = this.controlContext.getStore()
    if (control && !control.active) throw Error('空间控制已结束，拒绝迟到写入。')
    if (control && performance.now() >= control.deadline) throw Error('空间控制超时，拒绝迟到写入。')
    const lease = this.context.getStore()
    if (lease && !lease.active) throw Error('空间操作已结束，拒绝迟到写入。')
    return lease ? { ...lease.scope } : undefined
  }
  assertWritable() {
    this.current()
    if (!this.accepting && !this.context.getStore() && !this.controlContext.getStore()) throw Error('科研空间正在排空，已暂停新写入。')
  }
  assertControl() {
    this.current()
    if (!this.controlContext.getStore() || this.context.getStore()) throw Error('空间变更必须通过串行控制执行。')
  }
  bind<T>(fn: () => T): () => T {
    const lease = this.context.getStore()
    const control = this.controlContext.getStore()
    return () => this.controlContext.run(control!, () => this.context.run(lease!, fn))
  }
  /** 不作为普通任务跟踪；预算从出队开始，含排空/执行，不含队列等待。 */
  async runControl<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    this.current()
    if (this.context.getStore() || this.controlContext.getStore()) throw Error('空间控制不能嵌套在任务或控制内。')
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('空间控制必须指定有效超时。')
    if (this.controlBlocked) throw Error('空间控制失败，入口保持阻断。')
    if (this.externallyPaused) throw Error('外部排空已暂停入口，不能启动空间控制。')
    this.controlRequests += 1
    this.accepting = false
    const pending = this.controlTail.then(async () => {
      if (this.controlBlocked) throw Error('前序空间控制失败，入口保持阻断。')
      if (this.externallyPaused) throw Error('外部排空已暂停入口，不能启动空间控制。')
      const deadline = performance.now() + timeoutMs
      const lease = { active: true, deadline }
      let timer: ReturnType<typeof setTimeout> | undefined
      const ensureActive = () => {
        if (!lease.active || performance.now() >= deadline) throw Error('空间控制超时，入口保持阻断。')
      }
      const control = async () => {
        await this.drainTasks(timeoutMs)
        ensureActive()
        const result = await this.controlContext.run(lease, fn)
        ensureActive()
        return result
      }
      try {
        return await Promise.race([
          control(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('空间控制超时，入口保持阻断。')), timeoutMs)
          })
        ])
      } catch (error) {
        this.controlBlocked = true
        throw error
      } finally {
        lease.active = false
        clearTimeout(timer)
      }
    })
    this.controlTail = pending.catch(() => {})
    try { return await pending }
    finally {
      this.controlRequests -= 1
      if (this.controlRequests === 0 && !this.controlBlocked && !this.externallyPaused) this.resume()
    }
  }
  async run<T>(scope: OperationScope, fn: () => Promise<T>): Promise<T> {
    this.current()
    const parent = this.context.getStore()
    if (!parent && !this.accepting) throw Error('科研空间正在排空，已暂停新操作。')
    const lease = { scope: { ...(parent?.scope ?? scope) }, active: true }
    const pending = this.context.run(lease, async () => fn())
    this.pending.add(pending)
    try { return await pending }
    catch (error) { if (!this.accepting) this.failedDuringDrain = true; throw error }
    finally { lease.active = false; this.pending.delete(pending) }
  }
  async drain(timeoutMs: number): Promise<void> {
    this.stopAccepting()
    if (this.controlRequests > 0) throw Error('空间控制尚未结束；未授予外部排空交接。')
    await this.drainTasks(timeoutMs)
  }
  private async drainTasks(timeoutMs: number): Promise<void> {
    this.accepting = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.waitUntilEmpty(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('空间任务排空超时；未授予维护交接。')), timeoutMs) })
      ])
    } finally { clearTimeout(timer) }
  }
  private async waitUntilEmpty() {
    // 已接受父任务可创建子任务；每轮重新取集合，不能只等待初始快照。
    while (this.pending.size > 0) {
      const results = await Promise.allSettled([...this.pending])
      if (results.some(result => result.status === 'rejected')) this.failedDuringDrain = true
    }
    if (this.failedDuringDrain) throw Error('空间任务失败；未授予维护交接。')
  }
  stopAccepting() { this.externallyPaused = true; this.accepting = false }
  resume() {
    if (this.controlBlocked || this.controlRequests > 0) throw Error('空间控制未安全结束，不能恢复入口。')
    this.externallyPaused = false
    this.failedDuringDrain = false
    this.accepting = true
  }
}
export const workspaceOperationGate = new WorkspaceOperationGate()

/** 协作锁：不按PID或时间猜测残锁是否可删除。 */
export function acquireWorkspaceLock(root: string, name = 'workspace.writer-lock') {
  const canonical = realpathSync(root)
  const directory = join(canonical, '.mimir')
  mkdirSync(directory, { recursive: true })
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw Error('空间控制目录不能使用链接。')
  if (name !== 'workspace.writer-lock' && name !== 'registry.writer-lock') throw Error('未知写锁名称。')
  return acquireWriterLockFile(join(directory, name), canonical)
}

export function acquireWriterLockFile(path: string, canonicalRoot: string) {
  const directory = dirname(path)
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw Error('写锁父目录不能使用链接。')
  const token = randomUUID()
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })) }
  catch (error) { closeSync(fd); unlinkSync(path); throw error }
  let active = true
  let descriptorClosed = false
  return { root: canonicalRoot, release() {
    if (!active) return
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    if (saved.token !== token) throw Error('写锁已被替换；不删除其他写者的锁。')
    if (!descriptorClosed) { closeSync(fd); descriptorClosed = true }
    unlinkSync(path)
    active = false
  } }
}
