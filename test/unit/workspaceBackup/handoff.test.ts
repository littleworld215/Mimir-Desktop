import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'

async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/handoff.ts')).catch(() => ({} as any))
  expect(mod.MaintenanceHandoff).toBeTypeOf('function')
  return mod
}

function deps(gate = new WorkspaceOperationGate()) {
  return {
    gate, timeoutMs: 100,
    cancelApprovals: vi.fn(async () => {}),
    stopProducers: vi.fn(async () => {}),
    closeMcp: vi.fn(async () => {}),
    closeManagedProcesses: vi.fn(async () => {}),
    closeAssets: vi.fn(async () => {}),
    launchMaintenance: vi.fn(async () => {})
  }
}

it('窗口拒绝关闭时没有任何后台清理或维护启动', async () => {
  const { MaintenanceHandoff } = await moduleUnderTest()
  const ports = deps(), handoff = new MaintenanceHandoff(ports)
  handoff.request(); handoff.cancel()
  expect(handoff.state).toBe('idle')
  expect(ports.stopProducers).not.toHaveBeenCalled()
  expect(ports.launchMaintenance).not.toHaveBeenCalled()
})

it('只在窗口关闭且全部任务资源排空后启动一次维护', async () => {
  const { MaintenanceHandoff } = await moduleUnderTest()
  const ports = deps(), handoff = new MaintenanceHandoff(ports)
  let finish!: () => void
  const pending = ports.gate.run({ id: 'a', epoch: '1', root: '/synthetic' }, () => new Promise<void>(resolve => { finish = resolve }))
  handoff.request()
  const closing = handoff.windowClosed()
  await vi.waitFor(() => expect(ports.stopProducers).toHaveBeenCalledTimes(1))
  expect(ports.closeAssets).not.toHaveBeenCalled()
  expect(ports.launchMaintenance).not.toHaveBeenCalled()
  finish(); await pending; await closing
  expect(handoff.state).toBe('handedOver')
  await expect(handoff.windowClosed()).rejects.toThrow()
  expect(ports.launchMaintenance).toHaveBeenCalledTimes(1)
  expect(ports.closeAssets).toHaveBeenCalledTimes(1)
})

it.each(['cancelApprovals', 'stopProducers', 'closeMcp', 'closeManagedProcesses', 'closeAssets'] as const)('清理%s失败，不授予维护且不继续关闭后续资源', async key => {
  const { MaintenanceHandoff } = await moduleUnderTest()
  const ports = deps()
  ports[key].mockRejectedValue(new Error('synthetic secret must not enter public error'))
  const handoff = new MaintenanceHandoff(ports)
  handoff.request()
  await expect(handoff.windowClosed()).rejects.toThrow('维护交接失败')
  expect(handoff.state).toBe('blocked')
  expect(ports.launchMaintenance).not.toHaveBeenCalled()
  await expect(ports.gate.run({ id: 'a', epoch: '1', root: '/synthetic' }, async () => {})).rejects.toThrow()
})

it('超时后的迟到清理不继续执行或启动维护', async () => {
  const { MaintenanceHandoff } = await moduleUnderTest()
  const ports = deps(); ports.timeoutMs = 5
  let finish!: () => void
  ports.closeMcp.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const handoff = new MaintenanceHandoff(ports)
  handoff.request()
  await expect(handoff.windowClosed()).rejects.toThrow('维护交接失败')
  finish(); await new Promise(resolve => setTimeout(resolve, 10))
  expect(ports.closeManagedProcesses).not.toHaveBeenCalled()
  expect(ports.closeAssets).not.toHaveBeenCalled()
  expect(ports.launchMaintenance).not.toHaveBeenCalled()
})
it('同步原生清理阻塞事件循环超预算，也不能抢在定时器前授予交接', async () => {
  const { MaintenanceHandoff } = await moduleUnderTest()
  const ports = deps(); ports.timeoutMs = 5
  ports.stopProducers.mockImplementation(async () => {
    const until = performance.now() + 15
    while (performance.now() < until) { /* 模拟同步原生调用阻塞 */ }
  })
  const handoff = new MaintenanceHandoff(ports)
  handoff.request()
  await expect(handoff.windowClosed()).rejects.toThrow('维护交接失败')
  expect(ports.launchMaintenance).not.toHaveBeenCalled()
})
