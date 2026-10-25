import { WORKSPACE_BACKUP_CHANNELS } from '../../shared/workspaceBackupContracts'
import type { MaintenanceTaskManager } from './maintenanceTask'
import type { IpcMainLike } from './maintenanceRestoreHandler'

export function registerMaintenanceTaskHandlers(ipc: IpcMainLike, trusted: (event: unknown) => boolean, tasks: MaintenanceTaskManager): void {
  ipc.handle(WORKSPACE_BACKUP_CHANNELS.taskStatus, (event, request) => {
    if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
    return tasks.status(request)
  })
  for (const channel of [WORKSPACE_BACKUP_CHANNELS.taskCancel, WORKSPACE_BACKUP_CHANNELS.doctorCancel, WORKSPACE_BACKUP_CHANNELS.restoreCancel]) {
    ipc.handle(channel, (event, request) => {
      if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
      return tasks.cancel(request)
    })
  }
}
