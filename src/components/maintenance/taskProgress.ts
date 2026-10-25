import type { MaintenanceTaskKind } from '../../../shared/workspaceBackupContracts'

/** 页面内一轮操作的进度身份；完成/迟到事件不能复活为下一轮。 */
export class TaskProgressGuard {
  private epoch = 0
  private active?: { kind: MaintenanceTaskKind; epoch: number; taskId?: string }
  private retired = new Set<string>()
  get running(): boolean { return this.active !== undefined }
  begin(kind: MaintenanceTaskKind): number {
    this.active = { kind, epoch: ++this.epoch }
    return this.epoch
  }
  accept(kind: MaintenanceTaskKind, progress: { taskId?: string; stage: string }, allowAnonymous = false): boolean {
    const active = this.active
    if (!active || active.kind !== kind) return false
    if (!progress.taskId) return allowAnonymous && !active.taskId
    if (this.retired.has(progress.taskId)) return false
    if (active.taskId && active.taskId !== progress.taskId) return false
    if (!active.taskId && progress.stage !== 'starting') return false
    active.taskId = progress.taskId
    return true
  }
  end(epoch: number): void {
    if (this.active?.epoch !== epoch) return
    if (this.active.taskId) this.retired.add(this.active.taskId)
    this.active = undefined
  }
}
