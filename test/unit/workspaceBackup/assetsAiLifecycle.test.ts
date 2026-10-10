import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function setup() {
  const { AssetsStoreManager } = await import('../../../electron/assets/store')
  const ai = await import('../../../electron/assets/aiService')
  const { workspaceOperationGate: gate } = await import('../../../electron/workspaceBackup/operationGate')
  const { createAsset } = await import('../../../electron/assets/assetService')
  const { listAiDrafts } = await import('../../../electron/assets/aiDraftService')
  const root = mkdtempSync(join(tmpdir(), 'i6-assets-ai-'))
  const manager = new AssetsStoreManager({ active: () => ({ id: 'SYNTHETIC', path: root }), epoch: () => 'SYNTHETIC#1' }, (path, options) => new Database(path, options))
  const ctx = await manager.getForRequest(manager.context())
  const asset = createAsset(ctx, { name: 'SYNTHETIC', category: 'inbox', storageType: 'inline_text', content: 'SYNTHETIC' })
  const ready = deferred<void>(), actual = deferred<{ content: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }>()
  let signal!: AbortSignal
  const provider = { model: 'synthetic', complete: vi.fn(async (_prompt: string, accepted: AbortSignal) => {
    signal = accepted; ready.resolve(); return actual.promise
  }) }
  const result = { content: 'SYNTHETIC RESULT', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
  const stop = () => (ai as unknown as { stopAllAssetsAiTasksAndWait: () => Promise<void> }).stopAllAssetsAiTasksAndWait()
  const dispose = async () => { actual.resolve(result); await new Promise(resolve => setTimeout(resolve, 10)); await manager.close(); rmSync(root, { recursive: true, force: true }) }
  return { ai, gate, manager, ctx, asset, ready, actual, provider, result, signal: () => signal, stop, dispose, listAiDrafts }
}

for (const kind of ['draft', 'tags'] as const) {
  it(`资产${kind}及时取消后仍登记真实模型，停止必须等实际结束且迟到结果零写入`, async () => {
    const t = await setup(), controller = new AbortController()
    try {
      const task = kind === 'draft' ? t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider, signal: controller.signal })
        : t.ai.suggestAiTags(t.ctx, { assetId: t.asset.id }, { provider: t.provider, signal: controller.signal })
      await t.ready.promise
      const accepted = t.gate.pendingCount
      controller.abort(); await expect(task).rejects.toMatchObject({ code: 'AI_ABORTED' })
      const remaining = t.gate.pendingCount, aborted = t.signal().aborted
      let ended = false
      const stopped = typeof (t.ai as unknown as { stopAllAssetsAiTasksAndWait?: unknown }).stopAllAssetsAiTasksAndWait === 'function'
        ? t.stop().then(() => undefined, error => error).finally(() => { ended = true }) : Promise.resolve('NO STOP')
      await Promise.resolve(); const early = ended
      t.actual.resolve(t.result); await stopped
      expect(accepted).toBe(1); expect(remaining).toBe(1); expect(aborted).toBe(true); expect(early).toBe(false)
      expect(t.gate.pendingCount).toBe(0); expect(t.listAiDrafts(t.ctx).total).toBe(0)
      await expect(t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider })).rejects.toThrow()
      expect(t.provider.complete).toHaveBeenCalledTimes(1)
    } finally { await t.dispose() }
  })
}

it('超时及时反馈，但raw模型晚失败仍被停止捕获且不外泄错误正文', async () => {
  const t = await setup()
  try {
    const task = t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider, timeoutMs: 10 })
    await t.ready.promise; await expect(task).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
    const count = t.gate.pendingCount
    const stopped = typeof (t.ai as unknown as { stopAllAssetsAiTasksAndWait?: unknown }).stopAllAssetsAiTasksAndWait === 'function'
      ? t.stop().then(() => undefined, error => error) : Promise.resolve('NO STOP')
    t.actual.reject(Error('SYNTHETIC secret credential and body')); const error = await stopped
    expect(count).toBe(1); expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('credential')
    expect(t.listAiDrafts(t.ctx).total).toBe(0)
  } finally { await t.dispose() }
})

it('成功草稿发布仍在固定根任务租约内，入库后才结束任务', async () => {
  const t = await setup()
  try {
    let publishedScope: unknown, publishedCount = 0
    const write = t.ctx.write.bind(t.ctx)
    t.ctx.write = operation => {
      if (t.provider.complete.mock.calls.length > 0) { publishedScope = t.gate.current(); publishedCount = t.gate.pendingCount }
      return write(operation)
    }
    const task = t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider })
    await t.ready.promise; t.actual.resolve(t.result); await task
    expect(publishedScope).toEqual({ id: t.ctx.scope.workspaceId, epoch: t.ctx.scope.spaceEpoch, root: join(t.ctx.layout.root, '../..') })
    expect(publishedCount).toBeGreaterThan(0); expect(t.gate.pendingCount).toBe(0)
    expect(t.listAiDrafts(t.ctx).total).toBe(1)
  } finally { await t.dispose() }
})

it('同步草稿发布成功后取消不能把已落库结果误报AI_ABORTED', async () => {
  const t = await setup(), controller = new AbortController()
  try {
    const write = t.ctx.write.bind(t.ctx)
    t.ctx.write = operation => {
      const value = write(operation)
      if (t.provider.complete.mock.calls.length > 0) queueMicrotask(() => controller.abort())
      return value
    }
    const task = t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider, signal: controller.signal })
      .then(draft => ({ draft }), error => ({ error }))
    await t.ready.promise; t.actual.resolve(t.result); const result = await task
    t.ctx.write = write
    expect(result).toMatchObject({ draft: { content: t.result.content } })
    expect(t.listAiDrafts(t.ctx).total).toBe(1)
  } finally { await t.dispose() }
})

for (const cause of ['timeout', 'cancel'] as const) {
  it(`公开${cause}先返回，raw晚失败已经结束后停止仍脱敏拒绝`, async () => {
    const t = await setup(), controller = new AbortController()
    try {
      const task = t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider,
        ...(cause === 'timeout' ? { timeoutMs: 10 } : { signal: controller.signal }) })
      await t.ready.promise
      if (cause === 'cancel') controller.abort()
      await expect(task).rejects.toMatchObject({ code: cause === 'timeout' ? 'AI_TIMEOUT' : 'AI_ABORTED' })
      t.actual.reject(Error('SYNTHETIC secret credential and body'))
      await vi.waitFor(() => expect(t.gate.pendingCount).toBe(0))
      const result = await t.stop().then(() => undefined, error => error)
      expect(result).toBeInstanceOf(Error); expect(String(result)).not.toContain('credential')
      expect(t.listAiDrafts(t.ctx).total).toBe(0)
    } finally { await t.dispose() }
  })
}

it('已向调用方报告的正常模型失败不永久锁死后续停止', async () => {
  const t = await setup()
  try {
    const task = t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider })
    await t.ready.promise; t.actual.reject(Error('SYNTHETIC REPORTED ERROR'))
    await expect(task).rejects.toMatchObject({ code: 'AI_FAILED' })
    await expect(t.stop()).resolves.toBeUndefined()
  } finally { await t.dispose() }
})

it('公开取消后已结束的正常AbortError不记作未报告非取消故障', async () => {
  const t = await setup(), controller = new AbortController()
  try {
    const task = t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider, signal: controller.signal })
    await t.ready.promise; controller.abort()
    await expect(task).rejects.toMatchObject({ code: 'AI_ABORTED' })
    const expected = Error('SYNTHETIC ABORT'); expected.name = 'AbortError'; t.actual.reject(expected)
    await vi.waitFor(() => expect(t.gate.pendingCount).toBe(0))
    await expect(t.stop()).resolves.toBeUndefined()
  } finally { await t.dispose() }
})

it('接受后立即停止不启动模型', async () => {
  const t = await setup()
  try {
    const task = t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider }).then(() => undefined, error => error)
    const stopped = typeof (t.ai as unknown as { stopAllAssetsAiTasksAndWait?: unknown }).stopAllAssetsAiTasksAndWait === 'function'
      ? t.stop().then(() => undefined, error => error) : Promise.resolve('NO STOP')
    t.actual.resolve(t.result); await task; await stopped
    expect(t.provider.complete).not.toHaveBeenCalled()
  } finally { await t.dispose() }
})

it('父任务租约与资产会话空间不匹配时，模型发起前拒绝', async () => {
  const t = await setup()
  try {
    const request = t.gate.run({ id: 'OTHER', epoch: 'OTHER#1', root: '/synthetic/other' }, () =>
      t.ai.generateAiDraft(t.ctx, { assetId: t.asset.id, mode: 'polish' }, { provider: t.provider }))
    await expect(request).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
    expect(t.provider.complete).not.toHaveBeenCalled()
  } finally { await t.dispose() }
})

it('真实SDK取消不能早于忽略signal的实际fetch结束', async () => {
  const { configuredAssetsAiProvider } = await import('../../../electron/assets/aiProvider')
  const store = await import('../../stubs/store')
  store.setStoreValue('settings', { models: [{ apiKey: 'SYNTHETIC', modelId: 'synthetic', baseUrl: 'https://synthetic.invalid/v1' }] })
  const ready = deferred<void>(), completion = deferred<Response>(), controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => { ready.resolve(); return completion.promise }))
  try {
    let ended = false
    const task = configuredAssetsAiProvider()!.complete('SYNTHETIC', controller.signal).then(() => undefined, error => error).finally(() => { ended = true })
    await ready.promise; controller.abort(); await new Promise(resolve => setTimeout(resolve, 20)); const early = ended
    completion.resolve(new Response(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'synthetic', choices: [{ index: 0, message: { role: 'assistant', content: 'SYNTHETIC' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }))
    await task; expect(early).toBe(false)
  } finally { controller.abort(); vi.unstubAllGlobals() }
})
