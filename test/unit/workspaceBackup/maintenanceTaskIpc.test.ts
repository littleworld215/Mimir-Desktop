import { expect, it } from 'vitest'
import { MaintenanceTaskManager, maintenanceCheckpoint } from '../../../electron/workspaceBackup/maintenanceTask'
import { registerMaintenanceTaskHandlers } from '../../../electron/workspaceBackup/maintenanceTaskHandler'
import { WORKSPACE_BACKUP_CHANNELS as channels } from '../../../shared/workspaceBackupContracts'

it('task and old cancel channels require trusted main frame and exact task identity', async () => {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
  const trusted = {}, tasks = new MaintenanceTaskManager()
  registerMaintenanceTaskHandlers({ handle: (name, listener) => { handlers.set(name, listener) } }, e => e === trusted, tasks)
  expect(handlers.size).toBe(4)
  for (const handler of handlers.values()) expect(() => handler({})).toThrow('UNAUTHORIZED_SENDER')
  expect(handlers.get(channels.restoreCancel)!(trusted)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  const running = tasks.run('doctor', async () => { await maintenanceCheckpoint(); return { ok: true } })
  expect(handlers.get(channels.taskCancel)!(trusted, { taskId: tasks.current!.taskId, path: 'forged' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  expect(handlers.get(channels.taskStatus)!(trusted, { taskId: tasks.current!.taskId })).toMatchObject({ ok: true, task: { kind: 'doctor' } })
  expect(handlers.get(channels.taskCancel)!(trusted, { taskId: tasks.current!.taskId })).toMatchObject({ ok: true })
  await expect(running).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
})
