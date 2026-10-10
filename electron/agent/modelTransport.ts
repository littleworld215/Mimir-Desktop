import { AsyncLocalStorage } from 'node:async_hooks'
import { assertSpaceUnchanged } from '../library/store'
import { workspaceOperationGate } from '../workspaceBackup/operationGate'

const requestSignal = new AsyncLocalStorage<AbortSignal>()

/** 在实际传输层取消；不把信号交给会提前race结束的RunnableSequence。 */
export function withModelTransportSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return requestSignal.run(signal, fn)
}

export function currentModelTransportSignal(): AbortSignal | undefined { return requestSignal.getStore() }

/** SDK自身超时/取消与本轮信号并存；取消后拒绝新传输，已有传输仍由调用链等真实返回。 */
export const agentModelFetch: typeof fetch = (input, options) => {
  const signal = requestSignal.getStore()
  signal?.throwIfAborted()
  if (!signal) return globalThis.fetch(input, options)
  const scope = workspaceOperationGate.current()
  if (scope) assertSpaceUnchanged(scope.epoch)
  const ownSignal = options?.signal ?? (input instanceof Request ? input.signal : undefined)
  return globalThis.fetch(input, { ...options, signal: ownSignal ? AbortSignal.any([ownSignal, signal]) : signal })
}
