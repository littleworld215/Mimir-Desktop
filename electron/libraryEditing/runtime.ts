import { captureWorkspaceOperation } from '../library/store'
import { workspaceOperationGate, type OperationScope, type WorkspaceOperationGate } from '../workspaceBackup/operationGate'
import { WorkspaceTaskSupervisor } from '../workspaceBackup/taskSupervisor'
import type { EditingContext } from './service'
import { EditingError } from './validation'
export function createEditingRuntime(options: { gate: WorkspaceOperationGate; capture(): OperationScope }) {
  const supervisor = new WorkspaceTaskSupervisor(options.gate, options.capture)
  let accepting = true
  return {
    async run<T>(fn: (ctx: EditingContext) => Promise<T>, controller = new AbortController()): Promise<T> {
      if (!accepting) throw new EditingError('MAINTENANCE_BLOCKED', '恢复草稿入口已停止')
      const scope = { ...(options.gate.current() ?? options.capture()) }
      return supervisor.run(async signal => {
        const assertCurrent = () => {
          if (signal.aborted) throw new EditingError('CANCELED', '恢复草稿操作已取消')
          try {
            const current = options.capture(), lease = options.gate.current()
            if (!lease || [current, lease].some(v => v.id !== scope.id || v.epoch !== scope.epoch || v.root !== scope.root)) throw Error('scope')
          } catch { throw new EditingError('SPACE_CHANGED', '科研空间已变化，请保留输入后重新打开') }
        }
        assertCurrent(); return fn({ scope, assertCurrent })
      }, controller)
    },
    async stop() { accepting = false; await supervisor.stop() }
  }
}
export type EditingRuntime = ReturnType<typeof createEditingRuntime>
export const editingRuntime = createEditingRuntime({ gate: workspaceOperationGate, capture: captureWorkspaceOperation })
export const stopEditingTasksAndWait = () => editingRuntime.stop()
