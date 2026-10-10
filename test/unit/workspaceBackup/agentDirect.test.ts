import { beforeEach, expect, it, vi } from 'vitest'
import { START, END, StateGraph } from '@langchain/langgraph'
import { z } from 'zod'

beforeEach(() => vi.resetModules())
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
it('直接评分图被纳管，取消后等真实SDK工具结束，拒绝新请求和部分结果', async () => {
  const { AgentService, stopAllAgentTasksAndWait } = await import('../../../electron/agent/agentService')
  const { tool } = await import('../../../electron/agent/trackedTool')
  const { workspaceOperationGate: gate } = await import('../../../electron/workspaceBackup/operationGate')
  const store = await import('../../stubs/store')
  store.switchWorkspaceTo(store.createTestWorkspace('direct', '/synthetic/direct').id)
  const ready = deferred(), finish = deferred()
  const actual = tool(async () => { ready.resolve(); await finish.promise; return 'SYNTHETIC' }, {
    name: 'synthetic_score', description: 'SYNTHETIC', schema: z.object({})
  })
  const graph = new StateGraph({ channels: { messages: { reducer: (_old: unknown[], next: unknown[]) => next, default: () => [] } } })
    .addNode('work', async () => ({ messages: [{ content: String(await actual.invoke({})) }] }))
    .addEdge(START, 'work').addEdge('work', END).compile()
  const service = new AgentService(); Object.assign(service, { agent: graph })
  const task = service.sendMessage('SYNTHETIC', 'synthetic').then(() => undefined, error => error)
  await ready.promise
  const count = gate.pendingCount
  let stopped = false
  const stop = stopAllAgentTasksAndWait().then(() => { stopped = true }, () => { stopped = true })
  await Promise.resolve(); const early = stopped
  finish.resolve(); const result = await task; await stop
  expect(count).toBe(1); expect(early).toBe(false); expect(result).toBeInstanceOf(Error)
  await expect(service.sendMessage('SYNTHETIC', 'new')).rejects.toThrow('关闭')
})

it('响应头先返回不代表传输正文结束，执行范围等待实际字节读取', async () => {
  const { withAgentExecution } = await import('../../../electron/agent/executionScope')
  const { agentModelFetch, withModelTransportSignal } = await import('../../../electron/agent/modelTransport')
  const finish = deferred(), ready = deferred(), controller = new AbortController()
  let response!: Response
  const body = new ReadableStream<Uint8Array>({ async pull(target) {
    await finish.promise; target.enqueue(new TextEncoder().encode('SYNTHETIC')); target.close()
  } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
  try {
    let ended = false
    const task = withAgentExecution(controller.signal, () => withModelTransportSignal(controller.signal, async () => {
      response = await agentModelFetch('https://synthetic.invalid'); ready.resolve(); return response.text()
    })).finally(() => { ended = true })
    await ready.promise; await new Promise(resolve => setTimeout(resolve, 20)); const early = ended
    finish.resolve(); expect(await task).toBe('SYNTHETIC')
    expect(early).toBe(false)
  } finally { finish.resolve(); vi.unstubAllGlobals() }
})

it('真实ChatOpenAI连接失败后重试成功，不重抛已处理错误', async () => {
  const { ChatOpenAI } = await import('@langchain/openai')
  const { withAgentExecution } = await import('../../../electron/agent/executionScope')
  const { agentModelFetch, withModelTransportSignal } = await import('../../../electron/agent/modelTransport')
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('SYNTHETIC CONNECTION')).mockImplementation(async () => new Response(JSON.stringify({
    id: 'synthetic', object: 'chat.completion', created: 1, model: 'synthetic',
    choices: [{ index: 0, message: { role: 'assistant', content: 'SYNTHETIC OK' }, finish_reason: 'stop' }]
  }), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new AbortController()
  try {
    const model = new ChatOpenAI({ apiKey: 'SYNTHETIC', model: 'synthetic', maxRetries: 1,
      configuration: { baseURL: 'https://synthetic.invalid/v1', fetch: agentModelFetch } })
    const task = withAgentExecution(controller.signal, () => withModelTransportSignal(controller.signal, () => model.invoke('SYNTHETIC')))
    await expect(task).resolves.toMatchObject({ content: 'SYNTHETIC OK' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})

it('根返回时取消无人读取正文并排空，不等待背压后的下一次pull', async () => {
  const { withAgentExecution } = await import('../../../electron/agent/executionScope')
  const { agentModelFetch, withModelTransportSignal } = await import('../../../electron/agent/modelTransport')
  const cancelled = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel: cancelled
  }))))
  const controller = new AbortController()
  try {
    const task = withAgentExecution(controller.signal, () => withModelTransportSignal(controller.signal, async () => {
      await agentModelFetch('https://synthetic.invalid'); return 'DONE'
    }))
    const result = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve('HUNG'), 100))])
    expect(result).toBe('DONE'); expect(cancelled).toHaveBeenCalledOnce()
  } finally { controller.abort(); vi.unstubAllGlobals() }
})

it('正文被背压阻塞时，停止仍取消底层并拒绝结果', async () => {
  const { withAgentExecution } = await import('../../../electron/agent/executionScope')
  const { agentModelFetch, withModelTransportSignal } = await import('../../../electron/agent/modelTransport')
  const ready = deferred(), cancelled = vi.fn(), controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(target) { target.enqueue(new Uint8Array([1])) }, cancel: cancelled
  }))))
  try {
    const task = withAgentExecution(controller.signal, () => withModelTransportSignal(controller.signal, async () => {
      const response = await agentModelFetch('https://synthetic.invalid'); ready.resolve(); return response.text()
    })).then(() => undefined, error => error)
    await ready.promise; controller.abort()
    expect(await task).toBeInstanceOf(Error); expect(cancelled).toHaveBeenCalledOnce()
  } finally { controller.abort(); vi.unstubAllGlobals() }
})

it('根提前拒绝后才返回响应头，也必须取消未消费正文', async () => {
  const { withAgentExecution } = await import('../../../electron/agent/executionScope')
  const { agentModelFetch, withModelTransportSignal } = await import('../../../electron/agent/modelTransport')
  const ready = deferred(), headers = deferred(), cancelled = vi.fn(), controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => {
    ready.resolve(); await headers.promise
    return new Response(new ReadableStream({ start(target) { target.enqueue(new Uint8Array([1])) }, cancel: cancelled }))
  }))
  try {
    const task = withAgentExecution(controller.signal, () => withModelTransportSignal(controller.signal, async () => {
      void agentModelFetch('https://synthetic.invalid'); await ready.promise; throw Error('ROOT FAILURE')
    })).then(() => undefined, error => error)
    await ready.promise; await new Promise(resolve => setTimeout(resolve, 20)); headers.resolve()
    const result = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve('HUNG'), 100))])
    expect(result).toMatchObject({ message: 'ROOT FAILURE' }); expect(cancelled).toHaveBeenCalledOnce()
  } finally { headers.resolve(); controller.abort(); vi.unstubAllGlobals() }
})

it('文件后端调用纳管后，根异常仍等待已经开始的后端真实结束', async () => {
  const { withAgentExecution, trackAgentBackend } = await import('../../../electron/agent/executionScope')
  const ready = deferred(), finish = deferred()
  const backend = trackAgentBackend({ async write() { ready.resolve(); await finish.promise; return { error: null } } })
  let ended = false
  const task = withAgentExecution(new AbortController().signal, async () => {
    void backend.write(); await ready.promise; throw Error('SYNTHETIC ROOT FAILURE')
  }).then(() => undefined, error => error).finally(() => { ended = true })
  await ready.promise; await Promise.resolve(); const early = ended
  finish.resolve(); const error = await task
  expect(early).toBe(false); expect(error).toMatchObject({ message: 'SYNTHETIC ROOT FAILURE' })
})
