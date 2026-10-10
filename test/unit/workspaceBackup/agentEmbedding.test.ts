import { expect, it, vi } from 'vitest'
import { rerankByEmbedding } from '../../../electron/agent/embeddingRerank'

it('实际embedding SDK请求收到本轮取消信号，取消后不发送后续请求', async () => {
  let ready!: () => void, finish!: () => void, requestSignal!: AbortSignal
  const started = new Promise<void>(resolve => { ready = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  const fetch = vi.fn(async (_url, options) => {
    requestSignal = options.signal; ready(); await pending
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0] }] }),
      { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  try {
    const controller = new AbortController()
    const task = (rerankByEmbedding as any)([{ title: 'SYNTHETIC' }], 'SYNTHETIC',
      { apiKey: 'SYNTHETIC', baseUrl: 'https://synthetic.invalid/v1' }, controller.signal)
    const result = task.then(() => undefined, (error: unknown) => error)
    await started; controller.abort()
    const aborted = requestSignal.aborted
    finish(); await result
    expect(aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect((rerankByEmbedding as any)([{ title: 'SYNTHETIC' }], 'SYNTHETIC',
      { apiKey: 'SYNTHETIC' }, controller.signal)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals(); finish() }
})
