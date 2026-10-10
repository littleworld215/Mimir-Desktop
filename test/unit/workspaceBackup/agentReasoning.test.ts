import { expect, it, vi } from 'vitest'
import { AgentService } from '../../../electron/agent/agentService'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'

it('推理先失败而正文仍等待时立即观察拒绝，最终仍传播错误', async () => {
  switchWorkspaceTo(createTestWorkspace('reasoning', '/synthetic/reasoning').id)
  let finish!: () => void, started!: () => void
  const body = new Promise<void>(resolve => { finish = resolve })
  const ready = new Promise<void>(resolve => { started = resolve })
  const service = new AgentService(), unhandled: unknown[] = []
  const listener = (error: unknown) => unhandled.push(error)
  process.on('unhandledRejection', listener)
  Object.assign(service, { agent: { streamEvents: vi.fn(async () => ({
    messages: (async function* () {
      yield {
        text: (async function* () { started(); await body; yield 'SYNTHETIC' })(),
        reasoning: (async function* () { throw Error('synthetic reasoning failure') })()
      }
    })(), output: Promise.resolve({ messages: [] })
  })) } })
  try {
    const outcome = service.streamMessage('synthetic', 'reason', () => {}, { manual: true }).then(() => undefined, error => error)
    await ready
    await new Promise<void>(resolve => setImmediate(resolve))
    finish()
    expect((await outcome)?.message).toContain('synthetic reasoning failure')
    expect(unhandled).toEqual([])
  } finally { process.off('unhandledRejection', listener); finish() }
})
