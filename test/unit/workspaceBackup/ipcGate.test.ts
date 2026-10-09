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
it('显式串行装配的空间管理通道排空其它IPC，不能等待自身或绕过失败阻断', async () => {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/ipcGate.ts'))
  const gate = new WorkspaceOperationGate()
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (name: string, fn: (...args: any[]) => any) => { handlers.set(name, fn) } }
  mod.installWorkspaceIpcGate(ipc, gate, () => ({ id: 'a', epoch: '1', root: '/captured' }), { timeoutMs: 1000 })
  let finish!: () => void, switched = false
  ipc.handle('library:write', async () => new Promise<void>(resolve => { finish = resolve }))
  ipc.handle('workspaces:switch', async () => { gate.assertControl(); switched = true; return 'switched' })
  ipc.handle('workspaces:rename', async () => { gate.assertControl(); throw Error('control failure') })
  const task = handlers.get('library:write')!()
  const control = handlers.get('workspaces:switch')!()
  expect(switched).toBe(false)
  finish(); await task
  expect(await control).toBe('switched')
  await expect(handlers.get('workspaces:rename')!()).rejects.toThrow('control failure')
  await expect(handlers.get('workspaces:switch')!()).rejects.toThrow()
  await expect(handlers.get('library:write')!()).rejects.toThrow()
})
it('管理处理器把异常转换为ok:false时仍阻断控制，原失败结果保留给界面', async () => {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/ipcGate.ts'))
  const gate = new WorkspaceOperationGate(), handlers = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (name: string, fn: (...args: any[]) => any) => { handlers.set(name, fn) } }
  mod.installWorkspaceIpcGate(ipc, gate, () => ({ id: 'a', epoch: '1', root: '/captured' }), { timeoutMs: 1000 })
  const failure = { ok: false, message: 'safe synthetic error', inconsistent: true }
  ipc.handle('workspaces:switch', async () => failure)
  ipc.handle('workspaces:rename', async () => ({ ok: true }))
  expect(await handlers.get('workspaces:switch')!()).toBe(failure)
  await expect(handlers.get('workspaces:rename')!()).rejects.toThrow()
  expect(() => gate.assertWritable()).toThrow()
})
