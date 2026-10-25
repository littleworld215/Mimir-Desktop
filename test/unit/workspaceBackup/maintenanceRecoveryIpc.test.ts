import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { RestoreError } from '../../../electron/workspaceBackup/restoreContracts'
const id = '11111111-1111-4111-8111-111111111111'
async function subject() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/maintenanceRecoveryHandler.ts')).catch(() => ({}))
  expect(mod.buildRecoveryHandler).toBeTypeOf('function')
  return mod
}
async function gate() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/maintenanceWriteGate.ts')).catch(() => ({}))
  expect(mod.MaintenanceWriteGate).toBeTypeOf('function')
  return new mod.MaintenanceWriteGate(() => {})
}
function dependencies() {
  const recovery = {
    list: vi.fn(async () => ({ ok: true, writable: true, items: [], invalidRecords: 0, truncated: false })),
    register: vi.fn(async () => ({ spaceId: id, alreadyRegistered: false })),
    cleanup: vi.fn(async (_id: string, confirm: (view: unknown) => Promise<boolean>) => confirm({ spaceName: '合成空间', entries: 2, totalBytes: 8 }))
  }
  const confirmCleanup = vi.fn(async () => false)
  return { recovery, confirmCleanup, runWrite: async <T>(action: () => Promise<T>) => action() }
}
it('只信任维护窗口主框架，拒绝子框架、其它窗口和已销毁窗口', async () => {
  const { isTrustedMaintenanceRequest } = await subject()
  const frame = {}, webContents = { mainFrame: frame }, owner = { webContents, isDestroyed: () => false }
  expect(isTrustedMaintenanceRequest({ sender: webContents, senderFrame: frame }, owner)).toBe(true)
  expect(isTrustedMaintenanceRequest({ sender: webContents, senderFrame: {} }, owner)).toBe(false)
  expect(isTrustedMaintenanceRequest({ sender: {}, senderFrame: frame }, owner)).toBe(false)
  expect(isTrustedMaintenanceRequest({ sender: webContents, senderFrame: frame }, { ...owner, isDestroyed: () => true })).toBe(false)
})
it.each([undefined, { operationId: '../../secret', action: 'cleanup' }, { operationId: id, action: 'remove' }, { operationId: id, action: 'cleanup', targetRoot: 'C:/foreign' }])('非法ID/动作/额外路径字段在服务调用前拒绝 %j', async request => {
  const { buildRecoveryHandler } = await subject(), deps = dependencies(), handler = buildRecoveryHandler(deps)
  expect(await handler.action(request)).toMatchObject({ ok: false, code: 'INVALID_TARGET' })
  expect(deps.recovery.register).not.toHaveBeenCalled(); expect(deps.recovery.cleanup).not.toHaveBeenCalled()
})
it('登记桥只传操作ID，不把服务内部字段透给渲染层', async () => {
  const { buildRecoveryHandler } = await subject(), deps = dependencies()
  deps.recovery.register.mockResolvedValue({ spaceId: id, alreadyRegistered: true, secretPath: 'C:/sensitive' } as never)
  const result = await buildRecoveryHandler(deps).action({ operationId: id, action: 'register' })
  expect(deps.recovery.register).toHaveBeenCalledWith(id)
  expect(result).toEqual({ ok: true, operationId: id, action: 'register', spaceId: id, alreadyRegistered: true })
})
it('拒绝主进程确认时返回取消并保留资料', async () => {
  const { buildRecoveryHandler } = await subject(), deps = dependencies()
  expect(await buildRecoveryHandler(deps).action({ operationId: id, action: 'cleanup' })).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(deps.confirmCleanup).toHaveBeenCalledOnce()
})
it('异常只带安全错误码，系统路径或正文不进入结果', async () => {
  const { buildRecoveryHandler } = await subject(), deps = dependencies()
  deps.recovery.register.mockRejectedValue(new RestoreError('RECHECK_FAILED', 'C:/private synthetic-secret'))
  const result = await buildRecoveryHandler(deps).action({ operationId: id, action: 'register' })
  expect(result).toMatchObject({ ok: false, code: 'RECHECK_FAILED' })
  expect(JSON.stringify(result)).not.toContain('private'); expect(JSON.stringify(result)).not.toContain('synthetic-secret')
})
it('列表裁剪内部路径和凭据，只留安全字段', async () => {
  const { buildRecoveryHandler } = await subject(), deps = dependencies()
  deps.recovery.list.mockResolvedValue({ ok: true, writable: false, items: [{ operationId: id, spaceName: '合成', createdAt: '2026-10-25', phase: 'published', status: 'pending-registration', entries: 2, totalBytes: 8, actions: ['register'], stagingRoot: 'C:/private', secret: 'synthetic-secret' }], invalidRecords: 0, truncated: false, profile: 'C:/private' } as never)
  const result = await buildRecoveryHandler(deps).list()
  expect(JSON.stringify(result)).not.toContain('private'); expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  expect(result.items[0].actions).toEqual([])
})

it('恢复列表只转发合法游标，不把游标解释为路径', async () => {
  const { buildRecoveryHandler } = await subject(), deps = dependencies(), handler = buildRecoveryHandler(deps)
  await handler.list(id)
  expect(deps.recovery.list).toHaveBeenCalledWith(id)
  deps.recovery.list.mockClear()
  await expect(handler.list('../../foreign')).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  expect(deps.recovery.list).not.toHaveBeenCalled()
})
it('注册的两个恢复通道都在服务调用前核对sender', async () => {
  const { registerRecoveryHandlers, buildRecoveryHandler } = await subject(), deps = dependencies()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  registerRecoveryHandlers({ handle: (channel: string, listener: (...args: unknown[]) => unknown) => listeners.set(channel, listener) }, () => false, buildRecoveryHandler(deps))
  expect([...listeners.keys()].sort()).toEqual(['workspaceBackup:recoveryAction', 'workspaceBackup:recoveryList'])
  for (const listener of listeners.values()) expect(() => listener({}, { operationId: id, action: 'register' })).toThrow('UNAUTHORIZED_SENDER')
  expect(deps.recovery.list).not.toHaveBeenCalled(); expect(deps.recovery.register).not.toHaveBeenCalled()
})
it('维护写操作共享互斥，前一个尚未完成时拒绝第二个', async () => {
  const writeGate = await gate()
  let release!: () => void
  const first = writeGate.run(() => new Promise<void>(resolve => { release = resolve }))
  await expect(writeGate.run(async () => 'second')).rejects.toMatchObject({ code: 'CONTROL_BLOCKED' })
  release(); await first
  expect(await writeGate.run(async () => 'next')).toBe('next')
})
it('任务失败仍释放互斥，写锁失效则继续拒绝', async () => {
  const writeGate = await gate()
  await expect(writeGate.run(async () => { throw Error('fault') })).rejects.toThrow('fault')
  expect(await writeGate.run(async () => 1)).toBe(1)
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/maintenanceWriteGate.ts'))
  const blocked = new mod.MaintenanceWriteGate(() => { throw Error('lock unavailable') })
  await expect(blocked.run(async () => 1)).rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' })
})
