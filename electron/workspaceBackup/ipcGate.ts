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

/**
 * 维护交接入口：渲染层显式请求进入维护窗口。
 *
 * 与其它控制通道一样**不被排空阻塞**（否则交接会等待自身）。处理函数只做两件事：
 * ① 校验请求来自当前窗口主框架；② 只触发交接状态机（request），不在此关闭资源。
 * 真正的排空/关资源由主进程在窗口 `closed` 后调用 handoff.windowClosed() 完成。
 */
export function installWorkspaceMaintenanceHandler(
  ipc: { handle(channel: string, fn: Handler): any },
  request: () => void,
  isTrustedSender?: (event: unknown) => boolean
) {
  ipc.handle('workspaceBackup:enterMaintenance', async (event: unknown) => {
    if (isTrustedSender && !isTrustedSender(event)) throw Error('UNAUTHORIZED_SENDER')
    request()
    return { ok: true }
  })
}
