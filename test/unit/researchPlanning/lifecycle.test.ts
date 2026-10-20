import { expect, it } from 'vitest'
import { installWorkspaceIpcGate } from '../../../electron/workspaceBackup/ipcGate'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { createPlanningRuntime } from '../../../electron/researchPlanning/runtime'

it('科研计划被维护阻断时返回稳定失败，不向renderer泄露异常', async () => {
  const gate = new WorkspaceOperationGate(), handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: (name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler) } }
  installWorkspaceIpcGate(ipc, gate, () => ({ id: 'space', epoch: 'epoch', root: 'synthetic' }))
  ipc.handle('researchPlanning:bootstrap', () => ({ ok: true }))
  gate.stopAccepting()
  expect(await handlers.get('researchPlanning:bootstrap')!()).toMatchObject({ ok: false, code: 'MAINTENANCE_BLOCKED' })
})
it('维护停止等待已接受操作真正结束，取消不会提前释放空间', async () => {
  const gate = new WorkspaceOperationGate(), runtime = createPlanningRuntime({ gate, capture: () => ({ id: 's', epoch: 'e', root: 'synthetic' }) })
  let enter!: () => void, release!: () => void, stopped = false
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const task = runtime.run(async ctx => { enter(); await held; ctx.assertCurrent() }).catch(error => error)
  await entered
  const stopping = runtime.stop().then(() => { stopped = true }, () => { stopped = true })
  expect(gate.pendingCount).toBeGreaterThan(0); expect(stopped).toBe(false)
  release()
  expect(await task).toMatchObject({ code: 'CANCELED' })
  await stopping
  expect(gate.pendingCount).toBe(0)
  await expect(runtime.run(async () => {})).rejects.toMatchObject({ code: 'MAINTENANCE_BLOCKED' })
})
