import { expect, it, vi } from 'vitest'
import { tool } from '../../../electron/agent/trackedTool'
import { z } from 'zod'
import { START, END, StateGraph } from '@langchain/langgraph'
import * as trace from '../../../electron/agent/toolTrace'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
type Scope = (signal: AbortSignal, fn: () => Promise<unknown>) => Promise<unknown>
const scope = () => (trace as unknown as { withAgentExecution?: Scope }).withAgentExecution

it('只将范围停止信号传入原工具函数，停止等待协作清理', async () => {
  const ready = deferred(), cleanup = deferred(), controller = new AbortController()
  const actual = tool(async (_input, runtime) => {
    ready.resolve()
    await new Promise<void>(resolve => runtime.signal!.addEventListener('abort', () => resolve(), { once: true }))
    await cleanup.promise; return 'CLEANED'
  }, { name: 'cooperative', description: 'SYNTHETIC', schema: z.object({}) })
  let ended = false
  const task = scope()!(controller.signal, () => actual.invoke({})).then(() => undefined, error => error).finally(() => { ended = true })
  await ready.promise; controller.abort(); await new Promise(resolve => setTimeout(resolve, 20))
  expect(ended).toBe(false); cleanup.resolve()
  const result = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve('HUNG'), 100))])
  expect(result).toBeInstanceOf(Error)
})

it('真实图取消先结束外层时，仍等待实际SDK工具函数结束', async () => {
  expect(scope()).toBeTypeOf('function')
  const ready = deferred(), finish = deferred(), controller = new AbortController()
  const body = vi.fn(async () => { ready.resolve(); await finish.promise; return 'SYNTHETIC' })
  const actual = trace.withToolTrace(tool(body, { name: 'synthetic_tool', description: 'SYNTHETIC', schema: z.object({}) }), {})
  const graph = new StateGraph({ channels: { text: { reducer: (_old: string, next: string) => next, default: () => '' } } })
    .addNode('work', async () => ({ text: String(await actual.invoke({})) }))
    .addEdge(START, 'work').addEdge('work', END).compile()
  let ended = false
  const task = scope()!(controller.signal, () => graph.invoke({}, { signal: controller.signal })).then(() => undefined, error => error)
    .finally(() => { ended = true })
  await ready.promise; controller.abort(); await new Promise(resolve => setTimeout(resolve, 20))
  const early = ended
  finish.resolve(); await task
  expect(early).toBe(false); expect(body).toHaveBeenCalledTimes(1)
})

it('SDK工具外层因取消拒绝，但实际函数晚到非取消失败必须保留', async () => {
  expect(scope()).toBeTypeOf('function')
  const ready = deferred(), finish = deferred(), controller = new AbortController()
  const actual = trace.withToolTrace(tool(async () => {
    ready.resolve(); await finish.promise; throw Error('SYNTHETIC BODY FAILURE')
  }, { name: 'late_failure', description: 'SYNTHETIC', schema: z.object({}) }), {})
  const task = scope()!(controller.signal, () => actual.invoke({}, { signal: controller.signal })).then(() => undefined, error => error)
  await ready.promise; controller.abort(); finish.resolve()
  expect(await task).toMatchObject({ message: 'SYNTHETIC BODY FAILURE' })
})

it('执行范围结束后遗留回调不能启动工具，正常结果与配置仍兼容', async () => {
  expect(scope()).toBeTypeOf('function')
  const body = vi.fn(async () => 'SYNTHETIC'), next = deferred()
  const actual = trace.withToolTrace(tool(body, { name: 'normal', description: 'SYNTHETIC', schema: z.object({}) }), {})
  let late!: Promise<unknown>
  const value = await scope()!(new AbortController().signal, async () => {
    late = next.promise.then(() => actual.invoke({})).then(() => undefined, error => error)
    return actual.invoke({})
  })
  expect(value).toBe('SYNTHETIC'); next.resolve()
  expect(await late).toBeInstanceOf(Error)
  expect(body).toHaveBeenCalledTimes(1)
})
