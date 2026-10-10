import { tool as sdkTool } from 'langchain/tools'
import { agentExecutionSignal, trackAgentExecution } from './executionScope'

/** 监督当前业务的双参数Promise工具；信号只传给原函数，不交回SDK提前取消race。 */
export const tool: typeof sdkTool = ((...args: Parameters<typeof sdkTool>) => {
  const [fn, fields] = args
  return sdkTool((input, runtime) => trackAgentExecution(async () => {
    const signal = agentExecutionSignal()
    const forwarded = signal ? { ...runtime, signal: runtime.signal ? AbortSignal.any([runtime.signal, signal]) : signal } : runtime
    return Reflect.apply(fn, undefined, [input, forwarded]) as ReturnType<typeof fn>
  }), fields)
}) as typeof sdkTool
