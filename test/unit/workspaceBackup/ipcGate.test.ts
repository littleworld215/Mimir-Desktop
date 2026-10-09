import { expect, it } from 'vitest'
import { join } from 'node:path'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
it('IPC统一跟踪真实异步回调，捕获空间；批准/取消通道不被排空阻塞', async () => {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/ipcGate.ts')).catch(() => ({} as any))
  expect(mod.installWorkspaceIpcGate).toBeTypeOf('function')
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }
  const gate = new WorkspaceOperationGate()
  mod.installWorkspaceIpcGate(ipc, gate, () => ({ id: 'a', epoch: '1', root: '/fixed' }))
  let finish!: () => void
  ipc.handle('library:testWrite', async () => { expect(gate.current()?.root).toBe('/fixed'); await new Promise<void>(resolve => { finish = resolve }) })
  ipc.handle('agent:approval-respond', async () => '拒绝')
  const pending = handlers.get('library:testWrite')!({})
  await Promise.resolve()
  const drain = gate.drain(1000)
  expect(gate.pendingCount).toBe(1)
  expect(await handlers.get('agent:approval-respond')!({})).toBe('拒绝')
  await expect(handlers.get('library:testWrite')!({})).rejects.toThrow()
  finish(); await pending; await drain
})
it('空间注册与切换通道不能绕过任务闸门', async () => {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/ipcGate.ts'))
  const gate = new WorkspaceOperationGate()
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (name: string, fn: (...args: any[]) => any) => { handlers.set(name, fn) } }
  mod.installWorkspaceIpcGate(ipc, gate, () => ({ id: 'a', epoch: '1', root: '/captured' }))
  for (const name of ['create', 'rename', 'remove', 'switch', 'setDefault']) ipc.handle(`workspaces:${name}`, async () => 'unexpected write')
  await gate.drain(100)
  for (const fn of handlers.values()) await expect(fn()).rejects.toThrow()
})
