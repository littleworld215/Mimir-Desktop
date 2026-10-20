import { captureWorkspaceOperation } from '../library/store'
import { workspaceOperationGate, type OperationScope, type WorkspaceOperationGate } from '../workspaceBackup/operationGate'
import { WorkspaceTaskSupervisor } from '../workspaceBackup/taskSupervisor'
import { PlanningError } from './validation'
import type { PlanningContext } from './service'

export function createPlanningRuntime(options: { gate: WorkspaceOperationGate; capture(): OperationScope }) {
  const supervisor = new WorkspaceTaskSupervisor(options.gate, options.capture)
  let accepting = true
  return {
    run: async <T>(fn: (ctx: PlanningContext) => Promise<T>, controller = new AbortController()): Promise<T> => {
      if (!accepting) throw new PlanningError('MAINTENANCE_BLOCKED', '科研计划入口已停止')
      const scope = { ...(options.gate.current() ?? options.capture()) }
      return supervisor.run(async signal => {
        const assertCurrent = () => {
          if (signal.aborted) throw new PlanningError('CANCELED', '操作已取消')
          try {
            const current = options.capture(), lease = options.gate.current()
            if (!lease || [current, lease].some(v => v.id !== scope.id || v.epoch !== scope.epoch || v.root !== scope.root)) throw Error('scope')
          } catch { throw new PlanningError('SPACE_CHANGED', '科研空间已变化，请保留输入并重新打开') }
        }
        assertCurrent()
        return fn({ scope, assertCurrent })
      }, controller)
    },
    stop: async () => { accepting = false; await supervisor.stop() }
  }
}
export type PlanningRuntime = ReturnType<typeof createPlanningRuntime>
export const planningRuntime = createPlanningRuntime({ gate: workspaceOperationGate, capture: captureWorkspaceOperation })
export const stopPlanningTasksAndWait = () => planningRuntime.stop()
