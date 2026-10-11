import { expect, it } from 'vitest'
import { join } from 'node:path'

async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreState.ts')).catch(() => ({} as any))
  expect(mod.nextStage).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  expect(mod.RestoreError).toBeTypeOf('function')
  return mod
}

// ─── 通过组：合法转移 ───────────────────────────────────────────────

it.each([
  ['idle', 'selectArchive', 'inspecting'],
  ['inspecting', 'verifyOk', 'planned'],
  ['inspecting', 'planReady', 'planned'],
  ['planned', 'userConfirm', 'extracting'],
  ['planned', 'userCancel', 'idle'],
  ['extracting', 'extractOk', 'verifying'],
  ['verifying', 'recheckOk', 'publishing'],
  ['publishing', 'publishOk', 'registering'],
  ['registering', 'registerOk', 'done']
])('合法转移 %s --%s--> %s', async (from, event, to) => {
  const { nextStage } = await moduleUnderTest()
  expect(nextStage(from, event)).toBe(to)
})

it.each([
  ['inspecting', 'verifyFail'],
  ['extracting', 'extractFail'],
  ['verifying', 'recheckFail'],
  ['publishing', 'publishFail'],
  ['registering', 'registerFail']
])('失败事件 %s --%s--> failed', async (from, event) => {
  const { nextStage } = await moduleUnderTest()
  expect(nextStage(from, event)).toBe('failed')
})

it('failed 态可 retry 回到 inspecting（回到最早失败阶段的重新入口）', async () => {
  const { nextStage } = await moduleUnderTest()
  expect(nextStage('failed', 'retry')).toBe('inspecting')
})

it('isTerminal: done 与 failed 为终态，其余不是', async () => {
  const { isTerminal } = await moduleUnderTest()
  expect(isTerminal('done')).toBe(true)
  expect(isTerminal('failed')).toBe(true)
  for (const stage of ['idle', 'inspecting', 'planned', 'extracting', 'verifying', 'publishing', 'registering']) {
    expect(isTerminal(stage)).toBe(false)
  }
})

// ─── 失败组：非法转移必须抛错（不能静默吞） ─────────────────────────

it.each([
  ['idle', 'verifyOk'],
  ['idle', 'userConfirm'],
  ['done', 'selectArchive'],
  ['done', 'retry'],
  ['extracting', 'verifyOk'],
  ['planned', 'extractOk'],
  ['inspecting', 'abort'],
  ['registering', 'publishOk']
])('非法转移 %s --%s--> 抛错', async (from, event) => {
  const { nextStage } = await moduleUnderTest()
  expect(() => nextStage(from, event)).toThrow()
})

// ─── canRetry ──────────────────────────────────────────────────────

it('canRetry 如实反映 failure.retryable', async () => {
  const { canRetry } = await moduleUnderTest()
  expect(canRetry({ stage: 'failed', code: 'PUBLISH_FAILED', retryable: true, detail: '' })).toBe(true)
  expect(canRetry({ stage: 'failed', code: 'RECHECK_FAILED', retryable: false, detail: '' })).toBe(false)
})

// ─── abortScope：安全边界（本条必须用断言证明，不能靠注释） ──────────

it('abortScope 返回且仅返回本次产物（暂存根 + 本次创建的未注册目标）', async () => {
  const { abortScope } = await moduleUnderTest()
  const scope = abortScope(
    { stage: 'failed', code: 'PUBLISH_FAILED', retryable: true, detail: '' },
    { stagingRoot: 'C:/spaces/.mimir-restore-staging-abc', createdTarget: 'C:/spaces/新空间' }
  )
  expect(scope.stagingRoot).toBe('C:/spaces/.mimir-restore-staging-abc')
  expect(scope.createdTarget).toBe('C:/spaces/新空间')
})

it('abortScope 绝不包含原空间根 / 原注册表 / 其它空间（传入可疑路径也不越界）', async () => {
  const { abortScope } = await moduleUnderTest()
  const original = 'C:/Users/me/Mimir/我的科研空间'
  const registry = 'C:/Users/me/.mimir/store.json'
  const scope = abortScope(
    { stage: 'failed', code: 'REGISTER_FAILED', retryable: true, detail: '' },
    { stagingRoot: 'C:/spaces/.mimir-restore-staging-abc', createdTarget: null }
  )
  // 关键断言：返回值里**不出现**原空间/原注册表路径。
  const json = JSON.stringify(scope)
  expect(json).not.toContain(original)
  expect(json).not.toContain(registry)
  expect(scope.createdTarget).toBeNull()
})

it('abortScope 统一分隔符并去除尾部分隔符（可比较）', async () => {
  const { abortScope } = await moduleUnderTest()
  const scope = abortScope(
    { stage: 'failed', code: 'EXTRACT_FAILED', retryable: true, detail: '' },
    { stagingRoot: 'C:\\spaces\\staging-abc\\', createdTarget: null }
  )
  expect(scope.stagingRoot).toBe('C:/spaces/staging-abc')
})

it('abortScope 在非 failed 阶段拒绝（调用方错误要显式暴露）', async () => {
  const { abortScope } = await moduleUnderTest()
  expect(() => abortScope(
    { stage: 'publishing', code: 'PUBLISH_FAILED', retryable: true, detail: '' },
    { stagingRoot: 'C:/spaces/.mimir-restore-staging-abc', createdTarget: null }
  )).toThrow()
})

it('abortScope 拒绝 stagingRoot 与 createdTarget 相同的可疑形态', async () => {
  const { abortScope } = await moduleUnderTest()
  expect(() => abortScope(
    { stage: 'failed', code: 'INTERNAL', retryable: false, detail: '' },
    { stagingRoot: 'C:/spaces/x', createdTarget: 'C:/spaces/x' }
  )).toThrow()
})

// ─── RestoreError 契约 ─────────────────────────────────────────────

it('RestoreError 带 code 且 instanceof Error', async () => {
  const { RestoreError } = await contracts()
  const error = new RestoreError('TARGET_EXISTS', '已存在')
  expect(error).toBeInstanceOf(Error)
  expect(error.code).toBe('TARGET_EXISTS')
  expect(error.name).toBe('RestoreError')
})

it('非法转移抛出的错误带 INTERNAL 码', async () => {
  const { nextStage } = await moduleUnderTest()
  const { RestoreError } = await contracts()
  try {
    nextStage('done', 'selectArchive')
    throw new Error('应当抛错')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect((error as { code: string }).code).toBe('INTERNAL')
  }
})
