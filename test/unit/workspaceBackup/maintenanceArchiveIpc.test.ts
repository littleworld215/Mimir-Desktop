import { expect, it, vi } from 'vitest'
import { MaintenanceTaskManager } from '../../../electron/workspaceBackup/maintenanceTask'
import { buildArchiveDetailsHandler, registerArchiveDetailsHandler } from '../../../electron/workspaceBackup/maintenanceArchiveHandler'
import { MaintenanceWriteGate } from '../../../electron/workspaceBackup/maintenanceWriteGate'

const page = { summary: { metadata: 'legacy-unknown' as const, coverage: 'unknown' as const, excludedCount: 0, externalCount: 0, unresolvedCount: 0 }, offset: 0, items: [] }
it('仅固定可信主框架通道可读取，结果明确未做内容校验', async () => {
  const tasks = new MaintenanceTaskManager(), read = vi.fn(async () => page)
  const handler = buildArchiveDetailsHandler({ tasks, catalog: { read }, writeBusy: () => false })
  let listener: ((event: unknown, request: unknown) => unknown) | undefined
  registerArchiveDetailsHandler({ handle: (channel, callback) => { expect(channel).toBe('workspaceBackup:archiveDetails'); listener = callback } }, e => e === 'owner-main', handler)
  expect(() => listener!('other', { archiveId: 'id' })).toThrow('UNAUTHORIZED_SENDER')
  expect(await listener!('owner-main', { archiveId: 'id' })).toMatchObject({ ok: true, page, verification: 'not-run' })
})
it('G05写入活动时在读取前返回TASK_BUSY', async () => {
  const read = vi.fn(async () => page), handler = buildArchiveDetailsHandler({ tasks: new MaintenanceTaskManager(), catalog: { read }, writeBusy: () => true })
  expect(await handler({ archiveId: 'id' })).toMatchObject({ ok: false, code: 'TASK_BUSY' })
  expect(read).not.toHaveBeenCalled()
})
it('说明活动按doctor任务互斥，取消只作用于当前任务并等待读取结束', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve }), progress: string[] = []
  const tasks = new MaintenanceTaskManager(p => progress.push(p.stage))
  const writes = new MaintenanceWriteGate(() => { if (tasks.running) throw Error('TASK_BUSY') })
  const handler = buildArchiveDetailsHandler({ tasks, catalog: { read: async () => { await pending; return page } }, writeBusy: () => writes.running })
  const result = handler({ archiveId: 'id' })
  expect(tasks.current?.kind).toBe('doctor')
  await expect(writes.run(async () => 'unexpected')).rejects.toThrow()
  expect(await handler({ archiveId: 'other' })).toMatchObject({ ok: false, code: 'TASK_BUSY' })
  tasks.cancel({ taskId: tasks.current!.taskId })
  expect(tasks.running).toBe(true)
  finish()
  expect(await result).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(tasks.running).toBe(false)
  expect(progress).toContain('archive-details')
})
