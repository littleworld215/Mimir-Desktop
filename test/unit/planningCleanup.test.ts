import { afterEach, expect, it, vi } from 'vitest'
import { cleanupPlanningTest } from '../../e2e/helpers/planningCleanup'

afterEach(() => vi.useRealTimers())
const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
const outcome = (task: Promise<void>) => task.then(() => null, error => error)

it('草稿忙碌时不关闭，显式丢弃被允许后只关闭一次', async () => {
  clock()
  let ready = false
  const events: string[] = []
  const close = vi.fn(async () => { events.push('close'); if (!ready) throw Error('CLOSE_VETOED') })
  const discard = vi.fn(async () => { events.push(ready ? 'allowed' : 'busy'); return ready })
  const done = outcome(cleanupPlanningTest({ discard, close, timeoutMs: 50, pollMs: 5 }))
  await vi.advanceTimersByTimeAsync(0)
  expect(close).not.toHaveBeenCalled()
  ready = true
  await vi.advanceTimersByTimeAsync(5)
  expect(await done).toBeNull()
  expect(events).toEqual(['busy', 'allowed', 'close'])
  expect(close).toHaveBeenCalledTimes(1)
})

it('持续拒绝在同一预算内失败，不调用关闭或强制结束', async () => {
  clock()
  const close = vi.fn(async () => {})
  const done = outcome(cleanupPlanningTest({ discard: async () => false, close, timeoutMs: 50, pollMs: 5 }))
  await vi.advanceTimersByTimeAsync(50)
  expect(await done).toMatchObject({ code: 'PLANNING_CLEANUP_TIMEOUT', stage: 'discard' })
  expect(close).not.toHaveBeenCalled()
})

it('丢弃请求无响应也在预算内失败，迟到允许不触发关闭', async () => {
  clock()
  let release!: (allowed: boolean) => void
  const pending = new Promise<boolean>(resolve => { release = resolve })
  const close = vi.fn(async () => {})
  const done = outcome(cleanupPlanningTest({ discard: () => pending, close, timeoutMs: 50 }))
  await vi.advanceTimersByTimeAsync(50)
  expect(await done).toMatchObject({ code: 'PLANNING_CLEANUP_TIMEOUT', stage: 'discard' })
  release(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(close).not.toHaveBeenCalled()
})

it('丢弃异常原样报告，不把异常当忙碌重试或继续关闭', async () => {
  const failure = Error('DRAFT_REMOVE_FAILED')
  const close = vi.fn(async () => {})
  const result = await outcome(cleanupPlanningTest({ discard: async () => { throw failure }, close }))
  expect(result).toBe(failure)
  expect(close).not.toHaveBeenCalled()
})

it('允许后关闭无响应也受剩余预算限制，关闭只发起一次', async () => {
  clock()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const close = vi.fn(() => pending)
  let result: unknown
  const done = outcome(cleanupPlanningTest({ discard: async () => true, close, timeoutMs: 50 }))
    .then(value => { result = value })
  try {
    await vi.advanceTimersByTimeAsync(50)
    expect(result).toMatchObject({ code: 'PLANNING_CLEANUP_TIMEOUT', stage: 'close' })
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await done
  }
})

it('关闭失败原样报告，不自动重试关闭', async () => {
  const failure = Error('CLOSE_FAILED')
  const close = vi.fn(async () => { throw failure })
  expect(await outcome(cleanupPlanningTest({ discard: async () => true, close }))).toBe(failure)
  expect(close).toHaveBeenCalledTimes(1)
})
