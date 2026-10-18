import { afterEach, expect, it } from 'vitest'
import { installWorkspaceIpcGate } from '../../../electron/workspaceBackup/ipcGate'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { researchIpcHarness } from './ipcHarness'
const fixtures: ReturnType<typeof researchIpcHarness>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('新域维护拒绝也返回稳定结果，而其它域原契约保留', async () => {
  const h = researchIpcHarness(); fixtures.push(h)
  const gate = new WorkspaceOperationGate(), handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: (name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler) } }
  installWorkspaceIpcGate(ipc, gate, () => h.ctx.scope)
  ipc.handle('libraryResearch:overview', () => { throw Error('不应调用') })
  ipc.handle('library:listPapers', () => ({}))
  gate.stopAccepting()
  expect(await handlers.get('libraryResearch:overview')!()).toMatchObject({ ok: false, code: 'MAINTENANCE_BLOCKED' })
  await expect(handlers.get('library:listPapers')!()).rejects.toThrow()
})
it('stopWaitsForActualDialogCompletion，销毁发起窗口只取消不提前放开任务', async () => {
  const h = researchIpcHarness(); fixtures.push(h)
  const p = await h.call('export', { ...h.exportRequest, mode: 'preview' })
  if (!p.ok) throw Error(p.message)
  let release!: () => void, entered!: () => void, settled = false
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  h.state.beforeDialogReturn = async () => { entered(); await held }
  const writing = h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken })
  await started
  h.state.closed = true; h.sender.emit('destroyed')
  const stopping = h.runtime.stop().then(() => { settled = true; return undefined }, error => error)
  expect(h.gate.pendingCount).toBeGreaterThan(0); expect(settled).toBe(false)
  release()
  expect(await writing).toMatchObject({ ok: false, code: 'CANCELED' })
  expect(await stopping).toBeInstanceOf(Error)
  expect(h.gate.pendingCount).toBe(0)
  await expect(h.runtime.run(async () => {})).rejects.toThrow()
})
