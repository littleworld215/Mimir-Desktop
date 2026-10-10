import { AsyncLocalStorage } from 'node:async_hooks'
import { assertSpaceUnchanged } from '../library/store'
import { workspaceOperationGate } from '../workspaceBackup/operationGate'

interface Execution {
  signal: AbortSignal
  open: boolean
  pending: Set<Promise<unknown>>
  errors: unknown[]
  cleanups: Set<() => Promise<void>>
}
const execution = new AsyncLocalStorage<Execution>()
function isAbort(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Abort')
}

/** 记录真实函数寿命，不以SDK的取消race当作该函数完成。范围外保持旧行为。 */
export async function trackAgentExecution<T>(fn: () => Promise<T>): Promise<T> {
  const state = execution.getStore()
  if (!state) return fn()
  if (!state.open) throw Error('Agent执行范围已结束，拒绝迟到操作。')
  state.signal.throwIfAborted()
  const scope = workspaceOperationGate.current()
  if (scope) assertSpaceUnchanged(scope.epoch)
  const promise = Promise.resolve().then(() => {
    if (!state.open) throw Error('Agent执行范围已结束，拒绝尚未开始的操作。')
    state.signal.throwIfAborted()
    if (scope) assertSpaceUnchanged(scope.epoch)
    return fn()
  })
  state.pending.add(promise)
  try { return await promise }
  catch (error) { if (!state.open || state.signal.aborted) state.errors.push(error); throw error }
  finally { state.pending.delete(promise) }
}

/** SDK根已结束后封住入口，并等待已开始工具/后端真正结束；晚到真实故障优先于取消。 */
export async function withAgentExecution<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const state: Execution = { signal, open: true, pending: new Set(), errors: [], cleanups: new Set() }
  return execution.run(state, async () => {
    let result!: T
    try { result = await fn() }
    catch (error) { state.errors.push(error) }
    finally { state.open = false }
    await Promise.allSettled([...state.cleanups].map(async cleanup => {
      try { await cleanup() } catch (error) { state.errors.push(error) }
    }))
    while (state.pending.size > 0) await Promise.allSettled([...state.pending])
    const error = state.errors.find(value => !isAbort(value)) ?? state.errors[0]
    if (state.errors.length > 0) throw error
    signal.throwIfAborted()
    return result
  })
}

/** 已接受传输从响应头转入正文阶段，不是新任务；观察拒绝而不制造未处理异常。 */
export function observeAgentExecution(promise: Promise<unknown>): boolean {
  const state = execution.getStore()
  if (!state) return false
  if (!state.open && state.pending.size === 0) throw Error('Agent执行范围已结束，拒绝迟到传输。')
  const observed = promise.catch(error => {
    if (!state.open || state.signal.aborted) state.errors.push(error)
  }).finally(() => { state.pending.delete(observed) })
  state.pending.add(observed)
  return true
}

export function hasAgentExecution(): boolean { return execution.getStore() !== undefined }

export function agentExecutionSignal(): AbortSignal | undefined { return execution.getStore()?.signal }

/** 根返回后不转移响应所有权；未消费传输必须取消。 */
export function onAgentExecutionClose(cleanup: () => Promise<void>): () => void {
  const state = execution.getStore()
  if (state && !state.open) {
    // 已接受fetch可能在根退出后才收到响应头；此时立即接住收尾。
    observeAgentExecution(Promise.resolve().then(cleanup))
  } else state?.cleanups.add(cleanup)
  return () => { state?.cleanups.delete(cleanup) }
}

/** 后端入口在权限检查、文件操作与清理完成前保持受监督；内部同步辅助方法不改为Promise。 */
export function trackAgentBackend<T extends object>(backend: T): T {
  const methods = new Set(['read', 'readRaw', 'write', 'edit', 'delete', 'ls', 'glob', 'grep', 'uploadFiles', 'downloadFiles', 'execute'])
  return new Proxy(backend, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof key !== 'string' || !methods.has(key) || typeof value !== 'function') return value
      return (...args: unknown[]) => trackAgentExecution(async () => Reflect.apply(value, target, args))
    }
  })
}
