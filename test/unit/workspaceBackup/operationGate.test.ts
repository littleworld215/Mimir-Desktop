import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const faults = vi.hoisted(() => ({ failUnlink: false }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, unlinkSync: (path: string) => {
    if (faults.failUnlink) { faults.failUnlink = false; throw Error('synthetic unlink failure') }
    return fs.unlinkSync(path)
  } }
})
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function moduleUnderTest() {
  const path = join(process.cwd(), 'electron/workspaceBackup/operationGate.ts')
  const mod = await import(/* @vite-ignore */ path).catch(() => ({} as any))
  expect(mod.WorkspaceOperationGate).toBeTypeOf('function')
  return mod
}
it('共同空间锁拒绝第二写者，释放后可重开；不自动删除残锁', async () => {
  const mod = await moduleUnderTest()
  const root = mkdtempSync(join(tmpdir(), 'mimir-workspace-gate-')); roots.push(root)
  const lock = mod.acquireWorkspaceLock(root)
  const original = readFileSync(join(root, '.mimir/workspace.writer-lock'), 'utf8')
  expect(() => mod.acquireWorkspaceLock(root)).toThrow()
  expect(readFileSync(join(root, '.mimir/workspace.writer-lock'), 'utf8')).toBe(original)
  lock.release()
  mod.acquireWorkspaceLock(root).release()
})
it('删除锁失败后可重试释放，不能重复关闭已关闭的文件描述符', async () => {
  const mod = await moduleUnderTest()
  const root = mkdtempSync(join(tmpdir(), 'mimir-lock-unlink-')); roots.push(root)
  const lock = mod.acquireWorkspaceLock(root)
  faults.failUnlink = true
  expect(() => lock.release()).toThrow('synthetic unlink failure')
  expect(() => lock.release()).not.toThrow()
  mod.acquireWorkspaceLock(root).release()
})
it('闸门排空所有已接受任务，排空时拒绝新任务，完成后才允许维护', async () => {
  const { WorkspaceOperationGate } = await moduleUnderTest()
  const gate = new WorkspaceOperationGate()
  let finish!: () => void
  const pending = gate.run({ id: 'a', epoch: '1', root: '/synthetic' }, () => new Promise<void>(resolve => { finish = resolve }))
  await Promise.resolve()
  let drained = false
  const drain = gate.drain(1000).then(() => { drained = true })
  await expect(gate.run({ id: 'a', epoch: '1', root: '/synthetic' }, async () => {})).rejects.toThrow()
  expect(drained).toBe(false)
  finish(); await pending; await drain
  expect(drained).toBe(true)
})
it('排空期间已接受的任务仍可完成写入，裸写入被拒绝', async () => {
  const { WorkspaceOperationGate } = await moduleUnderTest()
  const gate = new WorkspaceOperationGate()
  let finish!: () => void
  const pending = gate.run({ id: 'a', epoch: '1', root: '/synthetic' }, async () => {
    await new Promise<void>(resolve => { finish = resolve })
    gate.assertWritable()
  })
  const drain = gate.drain(1000)
  expect(() => gate.assertWritable()).toThrow()
  finish(); await pending; await drain
})
it('排空超时不授予交接，恢复入口后原任务仍被跟踪', async () => {
  const { WorkspaceOperationGate } = await moduleUnderTest()
  const gate = new WorkspaceOperationGate()
  let finish!: () => void
  const pending = gate.run({ id: 'a', epoch: '1', root: '/synthetic' }, () => new Promise<void>(resolve => { finish = resolve }))
  await Promise.resolve()
  await expect(gate.drain(5)).rejects.toThrow()
  gate.resume()
  expect(gate.pendingCount).toBe(1)
  finish(); await pending; await gate.drain(100)
})
it('已接受任务在排空期间失败，必须阻断维护交接', async () => {
  const { WorkspaceOperationGate } = await moduleUnderTest()
  const gate = new WorkspaceOperationGate()
  let fail!: (error: Error) => void
  const pending = gate.run({ id: 'a', epoch: '1', root: '/synthetic' }, () => new Promise<void>((_, reject) => { fail = reject }))
  const caught = pending.catch(() => {})
  const drain = gate.drain(1000)
  fail(new Error('synthetic write failure'))
  await expect(drain).rejects.toThrow('未授予维护交接')
  await caught
})
it('嵌套任务保留捕获根，已结束的异步上下文不能继续写', async () => {
  const { WorkspaceOperationGate } = await moduleUnderTest()
  const gate = new WorkspaceOperationGate()
  let late!: () => void
  await gate.run({ id: 'a', epoch: '1', root: '/captured' }, async () => {
    await gate.run({ id: 'b', epoch: '2', root: '/wrong' }, async () => expect(gate.current().root).toBe('/captured'))
    late = gate.bind(() => gate.current())
  })
  expect(() => late()).toThrow()
})
it('父任务未等待的已接受子任务仍必须排空，不能提前交接', async () => {
  const { WorkspaceOperationGate } = await moduleUnderTest()
  const gate = new WorkspaceOperationGate()
  let finish!: () => void
  let child!: Promise<void>
  await gate.run({ id: 'a', epoch: '1', root: '/captured' }, async () => {
    child = gate.run({ id: 'b', epoch: '2', root: '/wrong' }, async () => {
      await new Promise<void>(resolve => { finish = resolve })
      gate.assertWritable()
      expect(gate.current().root).toBe('/captured')
    })
  })
  const caught = child.catch(() => {})
  expect(gate.pendingCount).toBe(1)
  let handedOver = false
  const drained = gate.drain(100).then(() => { handedOver = true })
  await Promise.resolve()
  expect(handedOver).toBe(false)
  finish(); await child; await caught; await drained
})
