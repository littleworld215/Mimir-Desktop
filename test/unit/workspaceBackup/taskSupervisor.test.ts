import { expect, it } from 'vitest'
import { join } from 'node:path'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'

const scope = { id: 'a', epoch: '1', root: '/synthetic' }
async function moduleUnderTest() {
  const module = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/taskSupervisor.ts')).catch(() => ({} as any))
  expect(module.WorkspaceTaskSupervisor).toBeTypeOf('function')
  return module
}
it('生产任务独立跟踪到真正结束，排空不提前成功，scope在回调内固定', async () => {
  const { WorkspaceTaskSupervisor } = await moduleUnderTest(), gate = new WorkspaceOperationGate()
  const supervisor = new WorkspaceTaskSupervisor(gate, () => scope)
  let finish!: () => void
  const task = supervisor.run(async () => {
    expect(gate.current()).toEqual(scope)
    await new Promise<void>(resolve => { finish = resolve })
  })
  await Promise.resolve()
  let drained = false
  const drain = gate.drain(1000).then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish(); await task; await drain
})
it('停止撤销所有任务并等待其实际完成，不能只发abort就算关闭', async () => {
  const { WorkspaceTaskSupervisor } = await moduleUnderTest(), gate = new WorkspaceOperationGate()
  const supervisor = new WorkspaceTaskSupervisor(gate, () => scope)
  let finish!: () => void, aborted = false
  const task = supervisor.run(async (signal: AbortSignal) => {
    signal.addEventListener('abort', () => { aborted = true })
    await new Promise<void>(resolve => { finish = resolve })
  })
  await Promise.resolve()
  let stopped = false
  const stop = supervisor.stop().then(() => { stopped = true })
  expect(aborted).toBe(true)
  await Promise.resolve(); expect(stopped).toBe(false)
  await expect(supervisor.run(async () => {})).rejects.toThrow()
  finish(); await task; await stop
})
it('任务同步开始前就停止也必须纳入关闭等待并收到取消信号', async () => {
  const { WorkspaceTaskSupervisor } = await moduleUnderTest(), gate = new WorkspaceOperationGate()
  const supervisor = new WorkspaceTaskSupervisor(gate, () => scope)
  let sawAbort = false
  const task = supervisor.run(async (signal: AbortSignal) => { sawAbort = signal.aborted })
  await supervisor.stop(); await task
  expect(sawAbort).toBe(true)
})
it('任务取消后真实失败不能伪装关闭成功，关闭失败后不接新任务', async () => {
  const { WorkspaceTaskSupervisor } = await moduleUnderTest(), gate = new WorkspaceOperationGate()
  const supervisor = new WorkspaceTaskSupervisor(gate, () => scope)
  const task = supervisor.run(async (signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
    throw Error('synthetic write failed')
  })
  const caught = task.catch(() => {})
  await Promise.resolve()
  await expect(supervisor.stop()).rejects.toThrow('任务')
  await caught
  await expect(supervisor.run(async () => {})).rejects.toThrow()
})
it('任务内不能等待自身停止，拒绝后外部仍可正常停止', async () => {
  const { WorkspaceTaskSupervisor } = await moduleUnderTest(), gate = new WorkspaceOperationGate()
  const supervisor = new WorkspaceTaskSupervisor(gate, () => scope)
  await supervisor.run(async () => { await expect(supervisor.stop()).rejects.toThrow('任务内') })
  await supervisor.stop()
})
