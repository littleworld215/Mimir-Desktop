import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { createRequire } = await import('node:module')
  const native = createRequire(import.meta.url)('node:fs') as typeof actual
  // 让生产ESM与CJS依赖使用同一故障边界，避免只拦到一侧的假反例。
  return { ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => native.createReadStream(...args),
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => native.createWriteStream(...args),
    open: (...args: any[]) => (native.open as (...values: any[]) => any)(...args),
    close: (...args: Parameters<typeof actual.close>) => native.close(...args)
  }
})
// CJS依赖内部require不经Vitest的ESM别名，拦截真实fs以观察其真实文件关闭。
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
const roots: string[] = []
const callbacks: Array<() => void> = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-backup-lifetime-'))
  roots.push(root)
  const source = join(root, 'source'), staging = join(root, 'staging'), destination = join(root, 'archive.zip')
  mkdirSync(source)
  const file = join(source, 'a.bin')
  writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 42))
  return { source, staging, destination, file, request: { root: source, stagingDir: staging, destination, assetsDb: null } }
}
afterEach(() => {
  for (const callback of callbacks.splice(0)) callback()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('输出写入中途失败，返回前内部来源读流必须实际close', async () => {
  const { createBackup } = await import('../../../electron/workspaceBackup/packer')
  const f = fixture()
  const read = fs.createReadStream, write = fs.createWriteStream
  let writer: ReturnType<typeof write> | undefined
  const sources: ReturnType<typeof read>[] = []
  vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
    const result = write(...args)
    if (String(args[0]).endsWith('.zip.partial')) writer = result
    return result
  })
  vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
    const stream = read(...args)
    if (writer && String(args[0]) === f.file) {
      sources.push(stream)
      stream.once('data', () => writer!.destroy(Object.assign(new Error('synthetic mid-write failure'), { code: 'ENOSPC' })))
    }
    return stream
  })
  try {
    await expect(createBackup(f.request)).rejects.toThrow('synthetic mid-write failure')
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.every(stream => stream.closed)).toBe(true)
  } finally {
    // RED时仍清理测试观察到的句柄，不能把泄漏留给下个测试。
    await Promise.all(sources.map(stream => stream.closed ? Promise.resolve() : new Promise<void>(resolve => {
      stream.once('close', resolve)
      stream.destroy()
    })))
  }
  expect(existsSync(f.destination)).toBe(false)
  expect(readdirSync(f.staging)).toEqual([])
})

it('独立验包的异步关闭失败必须传播，不能在end就宣告成功', async () => {
  const { createBackup } = await import('../../../electron/workspaceBackup/packer')
  const { verifyBackup } = await import('../../../electron/workspaceBackup/verify')
  const f = fixture()
  await createBackup(f.request)
  const close = fs.close
  vi.spyOn(fs, 'close').mockImplementation((fd, callback) => {
    close(fd, error => callback(error ?? Object.assign(new Error('synthetic close failure'), { code: 'EIO' })))
  })
  await expect(verifyBackup(f.destination)).rejects.toThrow('synthetic close failure')
})

it.each([
  { arrival: '普通回调', late: false, early: false },
  { arrival: '驱动窗口结束后才到达的回调', late: true, early: false },
  { arrival: '调用方提前结束时仍排空晚到回调', late: true, early: true }
])('独立验包等待真实关闭回调，前一轮未确认关闭不开始下一轮（$arrival）', async ({ late, early }) => {
  const { createBackup } = await import('../../../electron/workspaceBackup/packer')
  const { verifyBackup } = await import('../../../electron/workspaceBackup/verify')
  const f = fixture()
  await createBackup(f.request)
  const open = fs.open, close = fs.close
  let pending = 0, openedWhileClosing = false, closeCalls = 0, releaseFutureCloses = false
  const deliveries = new Set<Promise<void>>()
  let allowLateArrival = false, lateCallbackObserved = false, lateDelivery: (() => void) | undefined
  let notifyFirstHeld!: () => void
  const firstHeld = new Promise<void>(resolve => { notifyFirstHeld = resolve })
  let simulateEarlyDone!: () => void
  const earlyDone = new Promise<void>(resolve => { simulateEarlyDone = resolve })
  const earlyObservationFailure = Error('synthetic premature result while close callback is pending')
  const beginLateArrival = () => {
    allowLateArrival = true
    const deliver = lateDelivery; lateDelivery = undefined
    deliver?.()
  }
  vi.spyOn(fs, 'open').mockImplementation((...args: any[]) => {
    if (pending > 0) openedWhileClosing = true
    return (open as (...values: any[]) => any)(...args)
  })
  vi.spyOn(fs, 'close').mockImplementation((fd, callback) => {
    pending++
    const delayArrival = ++closeCalls === 2 && late
    let completeDelivery!: () => void, released = false
    const delivered = new Promise<void>(resolve => { completeDelivery = resolve })
    deliveries.add(delivered)
    const finishDelivery = () => { deliveries.delete(delivered); completeDelivery() }
    try {
      close(fd, error => {
        const release = () => {
          if (released) return
          released = true; pending--
          try { callback(error) } finally { finishDelivery() }
        }
        const deliver = () => {
          if (releaseFutureCloses) release()
          else { callbacks.push(release); notifyFirstHeld() }
        }
        if (!delayArrival) { deliver(); return }
        lateCallbackObserved = true
        if (early) simulateEarlyDone()
        const schedule = () => { setTimeout(deliver, 150) }
        if (allowLateArrival) schedule()
        else lateDelivery = schedule
      })
    } catch (error) {
      if (!released) { released = true; pending--; finishDelivery() }
      throw error
    }
  })
  let settled = false
  const actualVerifying = verifyBackup(f.destination)
  void actualVerifying.catch(() => {})
  // 仅模拟调用方过早完成；真实verify仍运行，留作失败反例的独立收尾。
  const verifying = (early ? Promise.race([actualVerifying, earlyDone]) : actualVerifying).finally(() => { settled = true })
  void verifying.catch(() => {})
  let deadline: ReturnType<typeof setTimeout> | undefined
  const exercise = async () => {
    try {
      await Promise.race([firstHeld, verifying.then(() => { throw Error('验包未等待扣住的关闭回调') })])
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(openedWhileClosing).toBe(false)
      // 先扣住并检查第一轮关闭，再持续放行；后续回调不依赖固定轮询窗口。
      releaseFutureCloses = true
      for (const callback of callbacks.splice(0)) callback()
      beginLateArrival()
      await Promise.race([verifying, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(Error('关闭回调驱动器遗漏了晚到回调')), 5000)
      })])
      if (early) {
        expect(pending).toBeGreaterThan(0)
        throw earlyObservationFailure
      }
      expect(openedWhileClosing).toBe(false)
      expect(pending).toBe(0)
      if (late) expect(lateCallbackObserved).toBe(true)
    } finally {
      if (deadline) clearTimeout(deadline)
      releaseFutureCloses = true
      beginLateArrival()
      for (const callback of callbacks.splice(0)) callback()
      await verifying.catch(() => {})
      // 即使调用方错误地提前完成，也必须等真实close回执完成交付。
      while (deliveries.size > 0) await Promise.all([...deliveries])
    }
  }
  try {
    if (early) {
      await expect(exercise()).rejects.toBe(earlyObservationFailure)
      expect(pending).toBe(0)
    } else await exercise()
  } finally {
    // RED仍不能留下真实I/O；该兜底不替代对exercise自身收尾状态的断言。
    releaseFutureCloses = true
    beginLateArrival()
    for (const callback of callbacks.splice(0)) callback()
    await actualVerifying.catch(() => {})
  }
  if (early) await actualVerifying
})
