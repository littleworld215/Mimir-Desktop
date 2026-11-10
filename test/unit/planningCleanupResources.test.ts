import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanupPlanningContext } from '../../e2e/helpers/planningCleanup'

const roots: { root: string; file: string }[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-planning-close-')), file = join(root, 'synthetic.txt')
  writeFileSync(file, 'synthetic planning only')
  roots.push({ root, file })
  const release = vi.fn(() => { unlinkSync(file); rmdirSync(root) })
  return { root, file, release }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  // Each root was exclusively created above; no recursive deletion is used.
  for (const { root, file } of roots.splice(0)) {
    if (existsSync(file)) unlinkSync(file)
    if (existsSync(root)) rmdirSync(root)
  }
})
const outcome = (task: Promise<void>) => task.then(() => null, error => error)
const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })

it('真实临时资料：关闭拒绝且进程仍活跃时保留文件，不释放', async () => {
  const f = fixture(), failure = Error('NATIVE_CLOSE_REJECTED')
  const result = await outcome(cleanupPlanningContext({ discard: async () => true,
    close: async () => { throw failure }, exitedNormally: () => false, release: f.release }))
  expect(result).toBe(failure)
  expect(readFileSync(f.file, 'utf8')).toBe('synthetic planning only')
  expect(f.release).not.toHaveBeenCalled()
})

it('真实临时资料：超时后迟到拒绝也不清理，原拒绝被观察', async () => {
  clock()
  const f = fixture()
  let rejectClose!: (error: Error) => void
  const close = new Promise<void>((_, reject) => { rejectClose = reject })
  const done = outcome(cleanupPlanningContext({ discard: async () => true, close: () => close,
    exitedNormally: () => false, release: f.release, timeoutMs: 50 }))
  await vi.advanceTimersByTimeAsync(50)
  expect(await done).toMatchObject({ code: 'PLANNING_CLEANUP_TIMEOUT', stage: 'close' })
  rejectClose(Error('LATE_CLOSE_REJECTED'))
  await vi.advanceTimersByTimeAsync(0)
  expect(existsSync(f.file)).toBe(true)
  expect(f.release).not.toHaveBeenCalled()
})

it('真实临时资料：超时后迟到正常退出也保留失败现场', async () => {
  clock()
  const f = fixture()
  let resolveClose!: () => void, exited = false
  const close = new Promise<void>(resolve => { resolveClose = resolve })
  const done = outcome(cleanupPlanningContext({ discard: async () => true, close: () => close,
    exitedNormally: () => exited, release: f.release, timeoutMs: 50 }))
  await vi.advanceTimersByTimeAsync(50)
  expect(await done).toMatchObject({ code: 'PLANNING_CLEANUP_TIMEOUT' })
  exited = true
  resolveClose()
  await vi.advanceTimersByTimeAsync(0)
  expect(existsSync(f.file)).toBe(true)
  expect(f.release).not.toHaveBeenCalled()
})

it('真实临时资料：关闭返回但正常退出无法确认时不删除', async () => {
  const f = fixture()
  const result = await outcome(cleanupPlanningContext({ discard: async () => true, close: async () => {},
    exitedNormally: () => false, release: f.release }))
  expect(result).toMatchObject({ code: 'PLANNING_CLEANUP_EXIT_UNCONFIRMED' })
  expect(existsSync(f.file)).toBe(true)
  expect(f.release).not.toHaveBeenCalled()
})

it('真实临时资料：仅明确允许且正常退出后释放一次', async () => {
  const f = fixture()
  let exited = false
  expect(await outcome(cleanupPlanningContext({ discard: async () => true,
    close: async () => { expect(existsSync(f.file)).toBe(true); exited = true },
    exitedNormally: () => exited, release: f.release }))).toBeNull()
  expect(existsSync(f.root)).toBe(false)
  expect(f.release).toHaveBeenCalledTimes(1)
})

it('真实临时资料：时钟越过预算而计时回调尚未调度时也不释放', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let now = 0, exited = false
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const f = fixture()
  const result = await outcome(cleanupPlanningContext({ discard: async () => true,
    close: async () => { now = 51; exited = true }, exitedNormally: () => exited,
    release: f.release, timeoutMs: 50 }))
  expect(result).toMatchObject({ code: 'PLANNING_CLEANUP_TIMEOUT', stage: 'close' })
  expect(existsSync(f.file)).toBe(true)
  expect(f.release).not.toHaveBeenCalled()
})
