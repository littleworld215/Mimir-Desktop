import { expect, it, vi } from 'vitest'
import { AgentService, stopAllAgentTasksAndWait } from '../../../electron/agent/agentService'
import { workspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'

it('委派一路失败后仍等待另一路真实结束，取消不能掩盖非取消失败', async () => {
  switchWorkspaceTo(createTestWorkspace('failure', '/synthetic/agent-failure').id)
  let finish!: () => void, bodyEnd!: () => void
  const tail = new Promise<void>(resolve => { finish = resolve })
  const ended = new Promise<void>(resolve => { bodyEnd = resolve })
  const service = new AgentService()
  Object.assign(service, { agent: { streamEvents: vi.fn(async () => ({
    messages: (async function* () { yield { text: (async function* () { yield 'SYNTHETIC' })() } })(),
    subagents: (async function* () {
      yield {
        name: 'synthetic',
        toolCalls: (async function* () { throw Error('synthetic iterator failure') })(),
        messages: (async function* () { await tail })()
      }
    })(),
    output: Promise.resolve({ messages: [{ content: 'SYNTHETIC' }] })
  })) } })
  let settled = false
  const task = service.streamMessage('synthetic', 'failure', event => { if (event.type === 'end') bodyEnd() }, { manual: true })
    .finally(() => { settled = true })
  // 提前绑定拒绝观察，避免故障触发后产生无处理拒绝。
  const outcome = task.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  await ended
  await new Promise<void>(resolve => setImmediate(resolve))
  const tracked = workspaceOperationGate.pendingCount
  const early = settled
  const stop = stopAllAgentTasksAndWait()
  const stopOutcome = stop.then(() => undefined, error => error)
  finish()
  const result = await outcome, stopError = await stopOutcome
  expect(early).toBe(false)
  expect(tracked).toBe(1)
  expect(result.error?.message).toContain('synthetic iterator failure')
  expect(stopError?.message).toContain('收口')
  expect(service.runningConversationIds()).toEqual([])
  expect(workspaceOperationGate.pendingCount).toBe(0)
})
