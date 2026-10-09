import type { OperationScope, WorkspaceOperationGate } from './operationGate'

type Handler = (...args: any[]) => any
class ControlResultFailure extends Error {
  constructor(readonly result: unknown) { super('空间管理返回失败，入口保持阻断。') }
}
/** 在普通模式注册任何域处理器前安装，维护模式不加载这些处理器。 */
export function installWorkspaceIpcGate(
  ipc: { handle(channel: string, fn: Handler): any },
  gate: WorkspaceOperationGate,
  capture: () => OperationScope,
  spaceControl?: { timeoutMs: number }
) {
  const handle = ipc.handle.bind(ipc)
  const control = new Set(['agent:approval-respond', 'agent:stop', 'terminal:close', 'workspaceBackup:enterMaintenance'])
  const workspaceChanges = new Set(['workspaces:create', 'workspaces:switch', 'workspaces:rename', 'workspaces:remove', 'workspaces:setDefault'])
  ipc.handle = (channel, fn) => {
    if (spaceControl && workspaceChanges.has(channel)) {
      return handle(channel, async (...args) => {
        try {
          return await gate.runControl(spaceControl.timeoutMs, async () => {
            const result = await fn(...args)
            if (result && typeof result === 'object' && result.ok === false) throw new ControlResultFailure(result)
            return result
          })
        } catch (error) {
          if (error instanceof ControlResultFailure) return error.result
          throw error
        }
      })
    }
    return handle(channel, control.has(channel) ? fn : (...args) => gate.run(capture(), async () => fn(...args)))
  }
}
