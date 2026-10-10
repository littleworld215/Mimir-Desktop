import { expect, it, vi } from 'vitest'
import { AgentService, stopAllAgentTasksAndWait } from '../../../electron/agent/agentService'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'

it('正文正常结束后的最终图失败必须拒绝，停止也不得成功', async () => {
  switchWorkspaceTo(createTestWorkspace('output-failure', '/synthetic/output-failure').id)
  let ended!: () => void, fail!: () => void
  const bodyEnd = new Promise<void>(resolve => { ended = resolve })
  const output = new Promise<never>((_resolve, reject) => { fail = () => reject(Error('synthetic output failure')) })
  const service = new AgentService()
  Object.assign(service, { agent: { streamEvents: vi.fn(async () => ({
    messages: (async function* () { yield { text: (async function* () { yield 'SYNTHETIC' })() } })(), output
  })) } })
  const task = service.streamMessage('synthetic', 'final', event => { if (event.type === 'end') ended() }, { manual: true })
  const outcome = task.then(() => undefined, error => error)
  await bodyEnd
  const stop = stopAllAgentTasksAndWait().then(() => undefined, error => error)
  fail()
  expect((await outcome)?.message).toContain('synthetic output failure')
  expect((await stop)?.message).toContain('收口')
})
