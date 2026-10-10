import { expect, it, vi } from 'vitest'
import { AgentService, stopAllAgentTasksAndWait } from '../../../electron/agent/agentService'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'

it('正文取消错误不能掩盖旁路随后出现的非取消错误', async () => {
  switchWorkspaceTo(createTestWorkspace('abort-failure', '/synthetic/abort-failure').id)
  let started!: () => void, mainFinish!: () => void, toolFinish!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const main = new Promise<void>(resolve => { mainFinish = resolve })
  const tool = new Promise<void>(resolve => { toolFinish = resolve })
  const service = new AgentService()
  Object.assign(service, { agent: { streamEvents: vi.fn(async () => {
    started()
    return {
      messages: (async function* () { await main; throw new DOMException('cancelled', 'AbortError') })(),
      toolCalls: (async function* () { await tool; throw Error('synthetic late tool failure') })()
    }
  }) } })
  const task = service.streamMessage('synthetic', 'late', () => {}, { manual: true })
  const result = task.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  await ready
  let stopped = false
  const stop = stopAllAgentTasksAndWait().finally(() => { stopped = true })
  const stopResult = stop.then(() => undefined, error => error)
  mainFinish()
  await new Promise<void>(resolve => setImmediate(resolve)); expect(stopped).toBe(false)
  toolFinish()
  expect((await result).error?.message).toContain('synthetic late tool failure')
  expect((await stopResult)?.message).toContain('收口')
})
