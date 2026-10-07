import { createServer, type Server } from 'node:http'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../../../electron/library/store', () => ({ getStoreValue: () => state.settings }))
import { configuredAssetsAiProvider } from '../../../electron/assets/aiProvider'
let server: Server, endpoint: string, payload: Record<string, unknown>, calls: number
beforeEach(async () => {
  payload = {}; calls = 0
  server = createServer((request, response) => {
    calls++
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      payload = JSON.parse(body)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 1, model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: ' 本地合成结果\n' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  state.settings = { selectedModelId: 'fake', models: [{ id: 'fake', modelId: 'fake-model', apiKey: 'synthetic-local-test-key', baseUrl: endpoint }] }
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
it('真实LangChain适配访问本机模拟端点，保留正文/用量，仅一次请求', async () => {
  const p = configuredAssetsAiProvider()!
  expect(await p.complete(' 合成原文\n', new AbortController().signal)).toEqual({ content: ' 本地合成结果\n', usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 } })
  expect(payload).toMatchObject({ model: 'fake-model', temperature: 0.3, messages: [{ role: 'user', content: ' 合成原文\n' }] })
  expect(calls).toBe(1)
})
it('真实SDK的已取消signal在HTTP发送前拒绝', async () => {
  const ac = new AbortController(); ac.abort()
  await expect(configuredAssetsAiProvider()!.complete('合成', ac.signal)).rejects.toThrow()
  expect(calls).toBe(0)
})
