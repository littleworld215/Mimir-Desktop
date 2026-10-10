import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function setup() {
  const { AgentService, stopAllAgentTasksAndWait } = await import('../../../electron/agent/agentService')
  const { workspaceOperationGate: gate } = await import('../../../electron/workspaceBackup/operationGate')
  const store = await import('../../stubs/store')
  const { currentModelTransportSignal } = await import('../../../electron/agent/modelTransport')
  const first = store.createTestWorkspace('first', '/synthetic/independent-first')
  const second = store.createTestWorkspace('second', '/synthetic/independent-second')
  store.switchWorkspaceTo(first.id)
  const ready = deferred<void>(), completion = deferred<unknown>()
  let signal: AbortSignal | undefined
  const model = {
    invoke: vi.fn(async (_input: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal ?? currentModelTransportSignal(); ready.resolve(); return completion.promise
    }),
    withStructuredOutput: () => model
  }
  const service = new AgentService()
  Object.assign(service, { scJudgeModel: model, agent: model })
  return { service, gate, store, first, second, ready, completion, model, signal: () => signal, stop: stopAllAgentTasksAndWait }
}

const history = [{ role: 'user' as const, content: 'SYNTHETIC' }]
const draft = { name: 'synthetic-domain', label: '合成', description: 'SYNTHETIC', systemPrompt: 'SYNTHETIC', toolIds: [] }

for (const kind of ['compress', 'generate'] as const) {
  it(`独立${kind}请求立即登记；停止传信号并等待忽略取消的模型真实结束，随后拒绝新请求`, async () => {
    const t = await setup()
    const run = () => kind === 'compress' ? t.service.compressHistory(history)
      : t.service.generateSubagentFromPrompt('SYNTHETIC', [])
    const task = run()
    const outcome = task.then(value => ({ value }), error => ({ error }))
    const acceptedCount = t.gate.pendingCount
    await t.ready.promise
    let stopped = false
    const stop = t.stop().then(() => { stopped = true }, () => { stopped = true })
    await Promise.resolve()
    const wasAborted = t.signal()?.aborted
    const wasEarly = stopped
    t.completion.resolve(kind === 'compress' ? { content: 'SYNTHETIC' } : draft)
    const result = await outcome; await stop
    expect(acceptedCount).toBe(1)
    expect(wasAborted).toBe(true); expect(wasEarly).toBe(false)
    expect('error' in result || ('value' in result && (result.value as { ok?: boolean })?.ok === false)).toBe(true)
    const later = await run().then(value => ({ value }), error => ({ error }))
    expect('error' in later || ('value' in later && (later.value as { ok?: boolean })?.ok === false)).toBe(true)
    expect(t.model.invoke).toHaveBeenCalledTimes(1)
  })
}

it('独立生成模型失败仍保留旧ok:false契约，但维护停止不能误报成功', async () => {
  const t = await setup()
  const task = t.service.generateSubagentFromPrompt('SYNTHETIC', [])
  await t.ready.promise
  const stop = t.stop().then(() => undefined, error => error)
  t.completion.reject(Error('SYNTHETIC MODEL FAILURE'))
  expect(await task).toMatchObject({ ok: false })
  expect(await stop).toBeInstanceOf(Error)
})

it('独立压缩接受后立即停止不启动模型', async () => {
  const t = await setup()
  const task = t.service.compressHistory(history).then(() => undefined, error => error)
  const stop = t.stop().then(() => undefined, error => error)
  // 失败基线已启动请求；先释放替身，避免留下未结束的合成任务。
  t.completion.resolve({ content: 'SYNTHETIC' })
  await task; await stop
  expect(t.model.invoke).not.toHaveBeenCalled()
})

it('父轮内压缩继承旧空间租约与调用方取消，暂停新任务不截断已接受子任务', async () => {
  const t = await setup(), controller = new AbortController()
  const scope = t.store.captureWorkspaceOperation()
  const parent = t.gate.run(scope, async () => {
    t.gate.stopAccepting()
    return t.service.compressHistory(history, controller.signal)
  })
  const outcome = parent.then(() => undefined, error => error)
  await t.ready.promise
  const count = t.gate.pendingCount
  controller.abort(); const aborted = t.signal()?.aborted
  t.completion.resolve({ content: 'SYNTHETIC' }); await outcome
  expect(count).toBe(2); expect(aborted).toBe(true)
})

it('独立请求延迟开始前切换空间阻止模型，不能用新空间重捕获', async () => {
  const t = await setup()
  const task = t.service.compressHistory(history).then(() => undefined, error => error)
  t.store.switchWorkspaceTo(t.second.id)
  t.completion.resolve({ content: 'SYNTHETIC' })
  expect(await task).toBeInstanceOf(Error)
  expect(t.model.invoke).not.toHaveBeenCalled()
})

it('独立生成晚到结果在空间切换后不得返回可采纳草稿', async () => {
  const t = await setup()
  const task = t.service.generateSubagentFromPrompt('SYNTHETIC', [])
  await t.ready.promise; t.store.switchWorkspaceTo(t.second.id)
  t.completion.resolve(draft)
  expect(await task).toMatchObject({ ok: false })
})

it('独立请求正常结果保留压缩文本与能力域字段、白名单过滤', async () => {
  const t = await setup()
  t.completion.resolve({ ...draft, toolIds: ['UNKNOWN'], content: '  SYNTHETIC  ' })
  expect(await t.service.compressHistory(history)).toBe('SYNTHETIC')
  expect(await t.service.generateSubagentFromPrompt('SYNTHETIC', [])).toMatchObject({ ok: true, draft: { ...draft, toolIds: [] } })
  expect(t.gate.pendingCount).toBe(0)
})
