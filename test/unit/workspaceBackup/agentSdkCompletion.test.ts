import { beforeEach, expect, it, vi } from 'vitest'
import { ChatOpenAI } from '@langchain/openai'

beforeEach(() => vi.resetModules())

async function fixture() {
  const { AgentService, stopAllAgentTasksAndWait } = await import('../../../electron/agent/agentService')
  const { workspaceOperationGate: gate } = await import('../../../electron/workspaceBackup/operationGate')
  const store = await import('../../stubs/store')
  const { agentModelFetch, withModelTransportSignal } = await import('../../../electron/agent/modelTransport')
  store.switchWorkspaceTo(store.createTestWorkspace('sdk', '/synthetic/sdk').id)
  return { service: new AgentService(), stop: stopAllAgentTasksAndWait, gate, agentModelFetch, withModelTransportSignal, store }
}

it('SDK延迟发起的实际传输在空间切换后必须拒绝，不发送旧空间内容', async () => {
  const t = await fixture()
  let ready!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const fetch = vi.fn(async () => new Response('SYNTHETIC'))
  vi.stubGlobal('fetch', fetch)
  try {
    const task = t.gate.run(t.store.captureWorkspaceOperation(), () => t.withModelTransportSignal(new AbortController().signal, async () => {
      ready(); await pending
      return t.agentModelFetch('https://synthetic.invalid')
    })).then(() => undefined, error => error)
    await started; t.store.switchWorkspaceTo(t.store.createTestWorkspace('new', '/synthetic/new').id)
    release()
    expect(await task).toBeInstanceOf(Error)
    expect(fetch).not.toHaveBeenCalled()
  } finally { release(); vi.unstubAllGlobals() }
})

for (const kind of ['generate', 'compress'] as const) {
it(`真实${kind}SDK取消不得早于忽略取消的合成fetch完成而解除跟踪`, async () => {
  const t = await fixture()
  let ready!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  let requestSignal: AbortSignal | undefined
  const fetch = vi.fn(async (_input: unknown, options?: RequestInit) => {
    requestSignal = options?.signal ?? undefined
    ready(); await pending
    return new Response(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 0, model: 'synthetic',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: kind === 'compress' ? 'SYNTHETIC' : JSON.stringify({
        name: 'synthetic-domain', label: '合成', description: 'SYNTHETIC', systemPrompt: 'SYNTHETIC', toolIds: []
      }) } }] }), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  try {
    const model = new ChatOpenAI({ apiKey: 'SYNTHETIC', model: 'synthetic', maxRetries: 0,
      configuration: { baseURL: 'https://synthetic.invalid/v1', fetch: t.agentModelFetch } })
    Object.assign(t.service, { scJudgeModel: model, reasoningOn: true })
    const task = (kind === 'generate' ? t.service.generateSubagentFromPrompt('SYNTHETIC', [])
      : t.service.compressHistory([{ role: 'user', content: 'SYNTHETIC' }])).then(value => ({ value }), error => ({ error }))
    await started
    let stopped = false
    const stop = t.stop().then(() => { stopped = true }, () => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    const early = stopped, count = t.gate.pendingCount, aborted = requestSignal?.aborted
    release(); const result = await task; await stop
    expect(early).toBe(false); expect(count).toBe(1)
    expect(aborted).toBe(true)
    expect('error' in result || ('value' in result && (result.value as { ok?: boolean })?.ok === false)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally { release(); vi.unstubAllGlobals() }
})
}
