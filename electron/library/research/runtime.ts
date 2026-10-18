import { captureWorkspaceOperation } from '../store'
import { listPapers, listProjects } from '../libraryService'
import { workspaceOperationGate } from '../../workspaceBackup/operationGate'
import { createEvidenceRuntime, evidenceRuntime } from '../evidence/runtime'
import type { ResearchContext } from './evidenceAccess'

export interface ResearchRuntime {
  run<T>(fn: (ctx: ResearchContext) => Promise<T>, controller?: AbortController): Promise<T>
  stop(): Promise<void>
}
/** 共用任务寿命实现和来源服务，不新增PDF读取或后台扫描器。 */
export function createResearchRuntime(options: Parameters<typeof createEvidenceRuntime>[0]): ResearchRuntime {
  const base = createEvidenceRuntime(options)
  return {
    run: (fn, controller) => base.run(ctx => fn({ ...ctx, sourceObservations: () => base.source.sourceObservations(ctx) }), controller),
    stop: () => base.stop()
  }
}
export const researchRuntime = createResearchRuntime({ gate: workspaceOperationGate, capture: captureWorkspaceOperation, catalog: { papers: listPapers, projects: listProjects }, source: evidenceRuntime.source })
export const stopResearchTasksAndWait = () => researchRuntime.stop()
