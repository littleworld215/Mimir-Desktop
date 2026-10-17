import { captureWorkspaceOperation } from '../store'
import { listPapers, listProjects } from '../libraryService'
import { workspaceOperationGate, type OperationScope, type WorkspaceOperationGate } from '../../workspaceBackup/operationGate'
import { WorkspaceTaskSupervisor } from '../../workspaceBackup/taskSupervisor'
import { createEvidenceSourceService } from './source'
import { EvidenceError } from './validation'
import type { EvidenceContext } from './service'

export function createEvidenceRuntime(options: { gate: WorkspaceOperationGate; capture(): OperationScope; catalog: EvidenceContext['catalog']; source?: ReturnType<typeof createEvidenceSourceService> }) {
  const supervisor = new WorkspaceTaskSupervisor(options.gate, options.capture)
  const source = options.source ?? createEvidenceSourceService()
  let accepting = true
  return {
    source,
    run: async <T>(fn: (ctx: EvidenceContext) => Promise<T>, controller = new AbortController()): Promise<T> => {
      if (!accepting) throw new EvidenceError('MAINTENANCE_BLOCKED', '证据入口已停止，请重新打开工作台')
      const scope = { ...(options.gate.current() ?? options.capture()) }
      return supervisor.run(async signal => {
        const assertCurrent = () => {
          if (signal.aborted) throw new EvidenceError('CANCELED', '证据操作已取消')
          try {
            const current = options.capture(), lease = options.gate.current()
            if (!lease || current.id !== scope.id || current.epoch !== scope.epoch || current.root !== scope.root || lease.id !== scope.id || lease.epoch !== scope.epoch || lease.root !== scope.root) throw Error('scope')
          } catch { throw new EvidenceError('SPACE_CHANGED', '科研空间已变化，请保留输入并重新打开') }
        }
        assertCurrent()
        return fn({ scope, signal, assertCurrent, catalog: options.catalog })
      }, controller)
    },
    stop: async () => { accepting = false; try { await supervisor.stop() } finally { source.clearSourceObservations() } }
  }
}
export const evidenceRuntime = createEvidenceRuntime({ gate: workspaceOperationGate, capture: captureWorkspaceOperation, catalog: { papers: listPapers, projects: listProjects } })
export const stopEvidenceTasksAndWait = () => evidenceRuntime.stop()
