import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentService } from '../../../electron/agent/agentService'
import { workspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { createTestWorkspace, switchWorkspaceTo, currentSpaceEpoch } from '../../stubs/store'

let first: ReturnType<typeof createTestWorkspace>, second: ReturnType<typeof createTestWorkspace>
beforeEach(() => {
  first = createTestWorkspace('agent-first', '/synthetic/agent-first')
  second = createTestWorkspace('agent-second', '/synthetic/agent-second')
  switchWorkspaceTo(first.id)
})
afterEach(() => workspaceOperationGate.resume())
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function serviceWith(streamEvents: ReturnType<typeof vi.fn>) {
  const service = new AgentService()
  // 只替代模型/图边界，运行真正streamMessage、runConversation与并发收尾。
  Object.assign(service, { agent: { streamEvents } })
  return service
}
function streamResult(toolTail = Promise.resolve()) {
  return {
    messages: (async function* () { yield { text: (async function* () { yield 'SYNTHETIC' })() } })(),
    toolCalls: (async function* () { await toolTail })(),
    output: Promise.resolve({ messages: [{ content: 'SYNTHETIC' }] })
  }
}
it('正文end不代表Agent结束，真实工具流收尾仍受排空与固定scope跟踪', async () => {
  const tail = deferred(), ended = deferred()
  const expectedEpoch = currentSpaceEpoch()
  let scope: ReturnType<typeof workspaceOperationGate.current>
  const graph = vi.fn(async () => { scope = workspaceOperationGate.current(); return streamResult(tail.promise) })
  const service = serviceWith(graph)
  const task = service.streamMessage('synthetic', 'c1', event => { if (event.type === 'end') ended.resolve() }, { manual: true })
  await ended.promise
  expect(scope).toEqual({ id: first.id, epoch: expectedEpoch, root: first.path })
  expect(graph.mock.calls[0][1].configurable.assetsScope).toEqual({ workspaceId: first.id, spaceEpoch: expectedEpoch })
  expect(workspaceOperationGate.pendingCount).toBe(1)
  let drained = false
  const drain = workspaceOperationGate.drain(2000).then(() => { drained = true })
  await new Promise<void>(resolve => setImmediate(resolve)); expect(drained).toBe(false)
  tail.resolve(); expect(await task).toBe('SYNTHETIC'); await drain
  expect(service.runningConversationIds()).toEqual([])
})
it('接受后回调开始前切空间拒绝执行模型图，清理会话登记', async () => {
  const graph = vi.fn(async () => streamResult()), service = serviceWith(graph)
  const task = service.streamMessage('synthetic', 'c2', () => {}, { manual: true })
  switchWorkspaceTo(second.id)
  await expect(task).rejects.toThrow('切换')
  expect(graph).not.toHaveBeenCalled(); expect(service.runningConversationIds()).toEqual([])
})
it('接受后立即用户停止，未启动的任务不调用模型，保持原取消返回契约', async () => {
  const graph = vi.fn(async () => streamResult()), service = serviceWith(graph)
  const task = service.streamMessage('synthetic', 'c3', () => {}, { manual: true })
  service.stopStreaming('c3')
  expect(await task).toBe('')
  expect(graph).not.toHaveBeenCalled(); expect(service.runningConversationIds()).toEqual([])
})
it('路由等待期间切空间，后续模型图不能启动', async () => {
  const ready = deferred(), finish = deferred()
  const graph = vi.fn(async () => streamResult()), service = serviceWith(graph)
  Object.assign(service, { runSkillRouting: async () => { ready.resolve(); await finish.promise; return null } })
  const task = service.streamMessage('synthetic', 'routing', () => {})
  await ready.promise; switchWorkspaceTo(second.id); finish.resolve()
  await expect(task).rejects.toThrow('切换')
  expect(graph).not.toHaveBeenCalled(); expect(service.runningConversationIds()).toEqual([])
})
it('同会话重发中止旧轮但仍跟踪旧轮收尾，旧轮不能清理新轮登记', async () => {
  const oldReady = deferred(), newReady = deferred(), oldFinish = deferred(), newFinish = deferred()
  let oldSignal!: AbortSignal
  const graph = vi.fn(async (state, options) => {
    if (state.messages.at(-1).content === 'old') {
      oldSignal = options.signal; oldReady.resolve(); await oldFinish.promise
    } else { newReady.resolve(); await newFinish.promise }
    return streamResult()
  })
  const service = serviceWith(graph)
  const oldTask = service.streamMessage('old', 'same', () => {}, { manual: true })
  await oldReady.promise
  const newTask = service.streamMessage('new', 'same', () => {}, { manual: true })
  await newReady.promise; expect(oldSignal.aborted).toBe(true)
  expect(workspaceOperationGate.pendingCount).toBe(2)
  oldFinish.resolve(); expect(await oldTask).toBe('')
  expect(service.runningConversationIds()).toEqual(['same'])
  expect(workspaceOperationGate.pendingCount).toBe(1)
  newFinish.resolve(); expect(await newTask).toBe('SYNTHETIC')
  expect(service.runningConversationIds()).toEqual([])
})
it('全局停止撤销模型信号，实际图未结束前不能成功关闭Agent入口', async () => {
  const module = await import('../../../electron/agent/agentService') as unknown as { stopAllAgentTasksAndWait?: () => Promise<void> }
  expect(module.stopAllAgentTasksAndWait).toBeTypeOf('function')
  const ready = deferred(), finish = deferred()
  let signal!: AbortSignal
  const graph = vi.fn(async (_state, options) => { signal = options.signal; ready.resolve(); await finish.promise; return streamResult() })
  const service = serviceWith(graph)
  const task = service.streamMessage('synthetic', 'c4', () => {}, { manual: true })
  await ready.promise
  let stopped = false
  const stop = module.stopAllAgentTasksAndWait!().then(() => { stopped = true })
  await Promise.resolve(); expect(signal.aborted).toBe(true); expect(stopped).toBe(false)
  expect(workspaceOperationGate.pendingCount).toBe(1)
  finish.resolve(); expect(await task).toBe(''); await stop
  expect(service.runningConversationIds()).toEqual([])
  await expect(service.streamMessage('new', 'c5', () => {}, { manual: true })).rejects.toThrow('关闭')
})
