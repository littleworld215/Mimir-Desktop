import { AsyncLocalStorage } from 'node:async_hooks'
import { assertSpaceUnchanged } from '../library/store'
import { workspaceOperationGate } from '../workspaceBackup/operationGate'
import { hasAgentExecution, observeAgentExecution, onAgentExecutionClose, trackAgentExecution } from './executionScope'

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
  return trackAgentExecution(async () => {
    const response = await globalThis.fetch(input, { ...options, signal: ownSignal ? AbortSignal.any([ownSignal, signal]) : signal })
    if (!response.body || !hasAgentExecution()) return response
    // fetch只保证响应头。正文读完或底层取消真正完成前，范围不能结束。
    const reader = response.body.getReader()
    let resolve!: () => void, reject!: (error: unknown) => void
    const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    observeAgentExecution(completed)
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    let cancelled = false
    let settled = false
    let output: ReadableStreamDefaultController<Uint8Array>
    let removeCleanup = () => {}
    const done = (error?: unknown) => {
      if (settled) return
      settled = true; removeCleanup(); signal.removeEventListener('abort', abort)
      if (error !== undefined) reject(error); else resolve()
    }
    const cancel = async (reason?: unknown) => {
      if (settled || cancelled) return
      cancelled = true
      try { await reader.cancel(reason); await reading; done() }
      catch (error) { done(error); throw error }
    }
    const abort = () => {
      output?.error(signal.reason)
      void cancel(signal.reason).catch(() => {})
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller },
      async pull(controller) {
        try {
          reading = reader.read()
          const item = await reading
          if (cancelled) return
          if (item.done) { controller.close(); done() }
          else controller.enqueue(item.value)
        } catch (error) { if (!cancelled) controller.error(error); done(error) }
      },
      async cancel(reason) {
        await cancel(reason)
      }
    })
    removeCleanup = onAgentExecutionClose(() => cancel())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  })
}
