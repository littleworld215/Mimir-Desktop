import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface OperationScope { id: string; epoch: string; root: string }
interface Lease { scope: OperationScope; active: boolean }
export class WorkspaceOperationGate {
  private context = new AsyncLocalStorage<Lease>()
  private pending = new Set<Promise<unknown>>()
  private accepting = true
  private failedDuringDrain = false
  get pendingCount() { return this.pending.size }
  current(): OperationScope | undefined {
    const lease = this.context.getStore()
    if (lease && !lease.active) throw Error('空间操作已结束，拒绝迟到写入。')
    return lease?.scope
  }
  assertWritable() {
    this.current()
    if (!this.accepting && !this.context.getStore()) throw Error('科研空间正在排空，已暂停新写入。')
  }
  bind<T>(fn: () => T): () => T {
    const lease = this.context.getStore()
    return () => this.context.run(lease!, fn)
  }
  async run<T>(scope: OperationScope, fn: () => Promise<T>): Promise<T> {
    const parent = this.context.getStore()
    if (parent) this.current()
    else if (!this.accepting) throw Error('科研空间正在排空，已暂停新操作。')
    const lease = { scope: { ...(parent?.scope ?? scope) }, active: true }
    const pending = this.context.run(lease, async () => fn())
    this.pending.add(pending)
    try { return await pending }
    catch (error) { if (!this.accepting) this.failedDuringDrain = true; throw error }
    finally { lease.active = false; this.pending.delete(pending) }
  }
  async drain(timeoutMs: number): Promise<void> {
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
  stopAccepting() { this.accepting = false }
  resume() { this.failedDuringDrain = false; this.accepting = true }
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
