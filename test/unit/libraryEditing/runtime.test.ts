import { expect, it } from 'vitest'
import { createEditingRuntime } from '../../../electron/libraryEditing/runtime'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { installWorkspaceIpcGate } from '../../../electron/workspaceBackup/ipcGate'
it('stop waits actual completion and a rejected canceled task blocks maintenance handoff', async () => {
  const gate = new WorkspaceOperationGate(), runtime = createEditingRuntime({ gate, capture: () => ({ id: 's', epoch: 'e', root: 'synthetic' }) })
  let enter!: () => void, release!: () => void, stopped = false
  const entered = new Promise<void>(r => { enter = r }), held = new Promise<void>(r => { release = r })
  const task = runtime.run(async ctx => { enter(); await held; ctx.assertCurrent() }).catch(e => e)
  await entered
  const stop = runtime.stop().then(() => { stopped = true; return null }, e => { stopped = true; return e })
  expect(stopped).toBe(false); expect(gate.pendingCount).toBeGreaterThan(0)
  release(); expect(await task).toMatchObject({ code: 'CANCELED' }); expect(await stop).toBeInstanceOf(Error)
  expect(gate.pendingCount).toBe(0); await expect(runtime.run(async () => {})).rejects.toMatchObject({ code: 'MAINTENANCE_BLOCKED' })
})
it('space changes and an ended parent lease cannot acquire a fresh renderer scope', async () => {
  const gate = new WorkspaceOperationGate(); let scope = { id: 's', epoch: 'e', root: 'old' }
  const runtime = createEditingRuntime({ gate, capture: () => scope }); let stale!: () => Promise<void>
  await runtime.run(async ctx => { stale = gate.bind(() => runtime.run(async () => {})); scope = { ...scope, epoch: 'new' }; expect(() => ctx.assertCurrent()).toThrow(/SPACE_CHANGED/) })
  await expect(stale()).rejects.toThrow(); expect('runFresh' in runtime).toBe(false); await runtime.stop()
})
it('outer IPC maintenance rejection remains a structured result', async () => {
  const gate = new WorkspaceOperationGate(), registered = new Map<string, (...args: any[]) => any>()
  const ipc = { handle: (n: string, f: (...args: any[]) => any) => { registered.set(n, f) } }
  installWorkspaceIpcGate(ipc, gate, () => ({ id: 's', epoch: 'e', root: 'synthetic' }))
  ipc.handle('libraryEditing:list', () => ({ ok: true })); gate.stopAccepting()
  expect(await registered.get('libraryEditing:list')!({})).toMatchObject({ ok: false, code: 'MAINTENANCE_BLOCKED' })
})
