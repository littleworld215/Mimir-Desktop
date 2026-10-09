import { captureWorkspaceOperation } from '../library/store'
import { workspaceOperationGate } from './operationGate'
import { WorkspaceTaskSupervisor } from './taskSupervisor'

/** 首批纳管会议刷新和独立PDF下载；不代表所有生产写入已经接入。 */
export const workspaceVenueTasks = new WorkspaceTaskSupervisor(workspaceOperationGate, captureWorkspaceOperation)
export const workspaceDownloadTasks = new WorkspaceTaskSupervisor(workspaceOperationGate, captureWorkspaceOperation)
