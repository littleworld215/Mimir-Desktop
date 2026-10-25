import { RestoreError } from './restoreContracts'

/** 维护进程自身的互斥，不进入普通业务的runControl，也不允许嵌套控制。 */
export class MaintenanceWriteGate {
  private active = false
  constructor(private readonly assertUsable: () => void) {}
  get running(): boolean { return this.active }
  async run<T>(action: () => Promise<T>): Promise<T> {
    try { this.assertUsable() } catch { throw new RestoreError('LOCK_UNAVAILABLE', '维护写锁不可用，当前仅可只读查看。') }
    if (this.active) throw new RestoreError('CONTROL_BLOCKED', '已有维护写任务进行中，请等待完成。')
    this.active = true
    try { return await action() } finally { this.active = false }
  }
}
