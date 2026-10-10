import type { RunnableConfig } from '@langchain/core/runnables'
import { withApprovalSource, type ApprovalSource } from './approval'
import { trackAgentExecution } from './executionScope'
export { withAgentExecution } from './executionScope'

export interface TraceTool {
  name: string
  description?: string
  schema?: unknown
  invoke(input: unknown, config?: RunnableConfig): Promise<unknown>
}
interface Hooks {
  onCall?: (name: string, args: unknown) => void
  onDone?: (name: string, out: unknown, durationMs: number) => void
  onError?: (name: string, error: unknown, durationMs: number) => void
  source?: ApprovalSource
}
/** 原型包装保持 schema 与 this；配置必须贯穿，否则会丢失 Agent 的取消信号。 */
export function withToolTrace(base: TraceTool, hooks: Hooks): TraceTool {
  const proxied = Object.create(base) as TraceTool
  proxied.invoke = async (input, config) => {
    hooks.onCall?.(base.name, input)
    const t0 = Date.now()
    const run = async () => {
      const out = await base.invoke.call(proxied, input, config)
      hooks.onDone?.(base.name, out, Date.now() - t0)
      return out
    }
    try { return await trackAgentExecution(() => hooks.source === undefined ? run() : withApprovalSource(hooks.source, run)) }
    catch (error) { hooks.onError?.(base.name, error, Date.now() - t0); throw error }
  }
  return proxied
}
