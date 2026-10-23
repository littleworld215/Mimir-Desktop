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

it('独立验包等待真实关闭回调，前一轮未确认关闭不开始下一轮', async () => {
  const { createBackup } = await import('../../../electron/workspaceBackup/packer')
  const { verifyBackup } = await import('../../../electron/workspaceBackup/verify')
  const f = fixture()
  await createBackup(f.request)
  const open = fs.open, close = fs.close
  let pending = 0, openedWhileClosing = false
  vi.spyOn(fs, 'open').mockImplementation((...args: any[]) => {
    if (pending > 0) openedWhileClosing = true
    return (open as (...values: any[]) => any)(...args)
  })
  vi.spyOn(fs, 'close').mockImplementation((fd, callback) => {
    pending++
    close(fd, error => {
      const release = () => { pending--; callback(error) }
      callbacks.push(release)
    })
  })
  let settled = false
  const verifying = verifyBackup(f.destination).finally(() => { settled = true })
  void verifying.catch(() => {})
  await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0))
  // 手动放行每个真实close回调；不能用未执行回调的end事件代替它。
  for (let round = 0; round < 10 && !settled; round++) {
    for (const callback of callbacks.splice(0)) callback()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await verifying
  expect(openedWhileClosing).toBe(false)
  expect(pending).toBe(0)
})
