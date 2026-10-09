import type { OperationScope, WorkspaceOperationGate } from './operationGate'

type Handler = (...args: any[]) => any
/** 在普通模式注册任何域处理器前安装，维护模式不加载这些处理器。 */
export function installWorkspaceIpcGate(ipc: { handle(channel: string, fn: Handler): any }, gate: WorkspaceOperationGate, capture: () => OperationScope) {
  const handle = ipc.handle.bind(ipc)
  const control = new Set(['agent:approval-respond', 'agent:stop', 'terminal:close', 'workspaceBackup:enterMaintenance'])
  ipc.handle = (channel, fn) => handle(channel, control.has(channel)
    ? fn : (...args) => gate.run(capture(), async () => fn(...args)))
}
