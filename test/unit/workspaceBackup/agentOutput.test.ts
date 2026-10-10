import { expect, it, vi } from 'vitest'
import { AgentService, stopAllAgentTasksAndWait } from '../../../electron/agent/agentService'
import { workspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'

it('取消正文迭代后仍等待图最终状态，不能只等待消费者收尾', async () => {
  switchWorkspaceTo(createTestWorkspace('output', '/synthetic/agent-output').id)
  let started!: () => void, abortBody!: () => void, finishGraph!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const body = new Promise<void>(resolve => { abortBody = resolve })
  const output = new Promise<{ messages: [] }>(resolve => { finishGraph = () => resolve({ messages: [] }) })
  const service = new AgentService()
  Object.assign(service, { agent: { streamEvents: vi.fn(async () => {
    started()
    return { messages: (async function* () { await body; throw new DOMException('cancelled', 'AbortError') })(), output }
  }) } })
  const task = service.streamMessage('synthetic', 'output', () => {}, { manual: true })
  await ready
  let stopped = false
  const stop = stopAllAgentTasksAndWait().then(() => { stopped = true })
  abortBody()
  await new Promise<void>(resolve => setImmediate(resolve))
  const early = stopped, tracked = workspaceOperationGate.pendingCount
  finishGraph(); expect(await task).toBe(''); await stop
  expect(early).toBe(false); expect(tracked).toBe(1)
  expect(service.runningConversationIds()).toEqual([])
})
