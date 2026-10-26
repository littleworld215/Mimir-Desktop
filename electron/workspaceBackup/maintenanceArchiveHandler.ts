import { WORKSPACE_BACKUP_CHANNELS, type MaintenanceArchiveDetailsResult } from '../../shared/workspaceBackupContracts'
import type { MaintenanceArchiveCatalog } from './maintenanceArchiveCatalog'
import { MaintenanceTaskManager, maintenanceCheckpoint, reportMaintenanceProgress } from './maintenanceTask'

export function buildArchiveDetailsHandler(deps: { catalog: Pick<MaintenanceArchiveCatalog, 'read'>; tasks: MaintenanceTaskManager; writeBusy(): boolean }) {
  return async (request: unknown): Promise<MaintenanceArchiveDetailsResult> => {
    if (deps.writeBusy()) return { ok: false, code: 'TASK_BUSY', detail: '已有维护写任务进行中，请稍后读取归档说明。' }
    return deps.tasks.run('doctor', async () => {
      reportMaintenanceProgress({ stage: 'archive-details', detail: '正在读取归档范围说明；尚未校验业务内容。' })
      try {
        const page = await deps.catalog.read(request)
        await maintenanceCheckpoint()
        return { ok: true as const, page, verification: 'not-run' as const }
      } catch (error) {
        const code = (error as { code?: string }).code
        return { ok: false as const, code: code && ['INVALID_REQUEST', 'SELECTION_CHANGED', 'MANIFEST_INVALID', 'VERSION_UNSUPPORTED', 'CANCELLED'].includes(code) ? code : 'ARCHIVE_DETAILS_FAILED', detail: '归档说明未能读取或已变化，请重新读取清单后重试。' }
      }
    })
  }
}
export function registerArchiveDetailsHandler(ipc: { handle(channel: string, listener: (event: unknown, request: unknown) => unknown): void }, trusted: (event: unknown) => boolean, handler: (request: unknown) => Promise<MaintenanceArchiveDetailsResult>): void {
  ipc.handle(WORKSPACE_BACKUP_CHANNELS.archiveDetails, (event, request) => {
    if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
    return handler(request)
  })
}
