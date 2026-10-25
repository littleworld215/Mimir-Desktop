import { describe, expect, it } from 'vitest'
import { MaintenanceTaskManager, maintenanceCheckpoint, enterMaintenanceCommit, maintenanceSignal, withoutMaintenanceTask } from '../../../electron/workspaceBackup/maintenanceTask'

describe('maintenance task identity and safe cancellation', () => {
  it('assigns IDs, reports terminal state, limits completed receipts', async () => {
    const progress: Array<{ taskId: string; state: string }> = []
    const tasks = new MaintenanceTaskManager(view => progress.push(view))
    await tasks.run('doctor', async () => ({ ok: true }))
    expect(progress[0].taskId).toMatch(/^[a-f\d-]{36}$/)
    expect(tasks.status({ taskId: progress[0].taskId })).toMatchObject({ ok: true, task: { state: 'done', kind: 'doctor', cancellable: false } })
    for (let i = 0; i < 21; i++) await tasks.run('doctor', async () => ({ ok: true }))
    expect(tasks.status({ taskId: progress[0].taskId })).toMatchObject({ ok: false })
  })
  it('old, anonymous and extra-field cancellation never targets the current task', async () => {
    const tasks = new MaintenanceTaskManager()
    const work = tasks.run('backup', async () => {
      expect(tasks.cancel(undefined)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
      expect(tasks.cancel({ taskId: '38f7433d-612b-4e86-8472-efb1ba44e9c9' })).toMatchObject({ ok: false })
      expect(tasks.cancel({ taskId: tasks.current!.taskId, extra: true })).toMatchObject({ ok: false })
      await maintenanceCheckpoint()
      return { ok: true }
    })
    await expect(work).resolves.toMatchObject({ ok: true })
  })
  it('accepted cancellation waits for actual cleanup and blocks a second task', async () => {
    const tasks = new MaintenanceTaskManager()
    let finish!: () => void
    const draining = new Promise<void>(resolve => { finish = resolve })
    let cleaned = false
    const running = tasks.run('restore', async () => {
      try { await maintenanceCheckpoint() }
      finally { await withoutMaintenanceTask(async () => { await draining; cleaned = true }) }
      return { ok: true }
    })
    const id = tasks.current!.taskId
    expect(tasks.cancel({ taskId: id })).toMatchObject({ ok: true })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(tasks.running).toBe(true)
    await expect(tasks.run('doctor', async () => ({ ok: true }))).resolves.toMatchObject({ ok: false, code: 'TASK_BUSY' })
    finish()
    await expect(running).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(cleaned).toBe(true)
    expect(tasks.running).toBe(false)
  })
  it('cannot cancel after commit and retains final success', async () => {
    const tasks = new MaintenanceTaskManager()
    const result = await tasks.run('backup', async () => {
      enterMaintenanceCommit('publishing')
      expect(tasks.cancel({ taskId: tasks.current!.taskId })).toMatchObject({ ok: false, code: 'NOT_CANCELLABLE' })
      expect(maintenanceSignal()?.aborted).toBe(false)
      return { ok: true }
    })
    expect(result).toEqual({ ok: true })
  })
  it('rejects commit if cancellation was already accepted', async () => {
    const tasks = new MaintenanceTaskManager()
    const result = await tasks.run('restore', async () => {
      tasks.cancel({ taskId: tasks.current!.taskId })
      enterMaintenanceCommit()
      return { ok: true }
    })
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' })
  })
  it('isolates asynchronous contexts and does not expose thrown paths', async () => {
    const a = new MaintenanceTaskManager(), b = new MaintenanceTaskManager()
    const results = await Promise.all([
      a.run('doctor', async () => { a.cancel({ taskId: a.current!.taskId }); await maintenanceCheckpoint(); return { ok: true } }),
      b.run('doctor', async () => { await maintenanceCheckpoint(); expect(maintenanceSignal()?.aborted).toBe(false); return { ok: true } })
    ])
    expect(results[0]).toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(results[1]).toEqual({ ok: true })
    const failure = await b.run('doctor', async () => { throw Error('C:\\secret\\credential.txt') })
    expect(JSON.stringify(failure)).not.toContain('secret')
    expect(failure).toMatchObject({ ok: false })
  })
})
