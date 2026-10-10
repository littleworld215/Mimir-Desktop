import { expect, it, vi } from 'vitest'
import { AgentService } from '../../../electron/agent/agentService'
import { UltraController } from '../../../electron/agent/ultra'
import { currentModelTransportSignal } from '../../../electron/agent/modelTransport'
vi.mock('../../../electron/agent/skills', () => ({ loadSkillRegistry: () => ({ skills: [{}], rejected: [] }) }))

async function probe(invoke: (model: any, signal: AbortSignal) => Promise<unknown>, value: unknown, mergedSignal = false) {
  let ready!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  let options: { signal?: AbortSignal } | undefined
  const model: any = {
    invoke: vi.fn(async (_messages, config) => {
      options = config ?? { signal: currentModelTransportSignal() }; ready(); await pending; return value
    }),
    withStructuredOutput: () => model
  }
  const controller = new AbortController()
  let settled = false
  const result = invoke(model, controller.signal).finally(() => { settled = true })
  const outcome = result.then(() => undefined, error => error)
  await started; controller.abort()
  await Promise.resolve(); const early = settled
  finish(); await outcome
  expect(early).toBe(false)
  if (!mergedSignal) expect(options?.signal).toBe(controller.signal)
  else expect(options?.signal).toBeInstanceOf(AbortSignal)
  expect(options?.signal?.aborted).toBe(true)
}
it('历史压缩把本轮取消信号传给实际模型边界并等真实返回', async () => {
  await probe((model, signal) => {
    const service = new AgentService(); Object.assign(service, { scJudgeModel: model })
    return (service.compressHistory as any)([{ role: 'user', content: 'SYNTHETIC' }], signal)
  }, { content: 'SYNTHETIC' }, true)
})
it('真实技能路由结构化调用接收取消信号', async () => {
  await probe((model, signal) => {
    const service = new AgentService(); Object.assign(service, { scJudgeModel: model })
    return (service as any).runSkillRouting('SYNTHETIC', 'route', signal, () => {})
  }, { intents: [], categories: [], complexity: 'low' })
})
it('Ultra文本前置调用接收取消信号', async () => {
  await probe((model, signal) => new UltraController({ judgeModel: model, candidateModel: model, emit: () => {} })
    .run({ message: 'SYNTHETIC', signal, manual: 'critique_reflect' }), { content: 'SYNTHETIC' })
})
it('Ultra结构化前置调用接收取消信号', async () => {
  await probe((model, signal) => new UltraController({ judgeModel: model, candidateModel: model, emit: () => {} })
    .run({ message: 'SYNTHETIC', signal, manual: 'self_consistency_vote' }), { roles: ['reviewer', 'empiricist'], reason: 'SYNTHETIC' })
})
