import { expect, it, vi, beforeEach } from 'vitest'
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, constructed: vi.fn(), invoke: vi.fn() }))
vi.mock('../../../electron/library/store', () => ({ getStoreValue: () => state.settings }))
vi.mock('@langchain/openai', () => ({ ChatOpenAI: class { constructor(config: unknown) { state.constructed(config) } invoke = state.invoke } }))
import { configuredAssetsAiProvider } from '../../../electron/assets/aiProvider'
beforeEach(() => { state.settings = {}; state.constructed.mockClear(); state.invoke.mockReset() })
it('无配置不构造模型；坏models数组/无Key安全返回null', () => {
  for (const settings of [{}, { models: {} }, { models: [null] }, { models: [{ modelId: 'm', apiKey: ' ' }] }]) {
    state.settings = settings; expect(configuredAssetsAiProvider()).toBeNull()
  }
  expect(state.constructed).not.toHaveBeenCalled()
})
it('复用当前选中模型与端点，禁止重试，沿用signal；只读取text块和规范化用量', async () => {
  state.settings = { selectedModelId: 'b', models: [{ id: 'a', apiKey: 'first', modelId: 'first' }, { id: 'b', apiKey: 'local-test-key', modelId: 'chosen', baseUrl: 'http://127.0.0.1:1/v1' }] }
  state.invoke.mockResolvedValue({ content: [{ type: 'reasoning', text: '不应保存' }, { type: 'text', text: '正文' }], usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
  const p = configuredAssetsAiProvider()!, signal = new AbortController().signal
  expect(await p.complete('prompt', signal)).toEqual({ content: '正文', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } })
  expect(p.model).toBe('chosen')
  expect(state.constructed).toHaveBeenCalledWith(expect.objectContaining({ model: 'chosen', maxRetries: 0, configuration: { baseURL: 'http://127.0.0.1:1/v1' } }))
  expect(state.invoke.mock.calls[0][1]).toEqual({ signal })
})
it('未选中回退首模型和deepseek-flash；缺失/脏用量不污染草稿', async () => {
  state.settings = { models: [{ id: 'a', apiKey: 'test' }] }
  state.invoke.mockResolvedValue({ content: '正文', usage_metadata: { input_tokens: -1, output_tokens: '2', total_tokens: Infinity } })
  const p = configuredAssetsAiProvider()!
  expect(p.model).toBe('deepseek-flash')
  expect((await p.complete('prompt', new AbortController().signal)).usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
})
