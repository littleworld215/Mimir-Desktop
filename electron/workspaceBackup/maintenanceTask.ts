import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { MaintenanceTaskKind, MaintenanceTaskView, MaintenanceTaskProgress, MaintenanceTaskStatus, MaintenanceCancelResult } from '../../shared/workspaceBackupContracts'

interface Context {
  cleanupFailed?: boolean
  view: MaintenanceTaskView
  controller: AbortController
  emit(detail: string): void
}
const context = new AsyncLocalStorage<Context | undefined>()
export class MaintenanceCancelled extends Error {
  readonly code = 'CANCELLED'
  constructor() { super('已请求取消，维护任务在安全点停止。') }
}
export function checkMaintenanceCancellation(): void {
  if (context.getStore()?.controller.signal.aborted) throw new MaintenanceCancelled()
}
export function maintenanceSignal(): AbortSignal | undefined { return context.getStore()?.controller.signal }
export function markMaintenanceCleanupFailure(): void {
  const current = context.getStore()
  if (current) current.cleanupFailed = true
}
export async function maintenanceCheckpoint(): Promise<void> {
  if (!context.getStore()) return
  checkMaintenanceCancellation()
  await setImmediate()
  checkMaintenanceCancellation()
}
export function reportMaintenanceProgress(progress: { stage: string; detail: string }): void {
  const current = context.getStore()
  if (!current) return
  current.view = { ...current.view, stage: progress.stage }
  current.emit(progress.detail)
}
export function enterMaintenanceCommit(stage = 'publishing'): void {
  checkMaintenanceCancellation()
  const current = context.getStore()
  if (!current) return
  current.view = { ...current.view, state: 'committing', stage, cancellable: false }
  current.emit('正在提交结果，无法安全取消。')
}
/** 取消后的收尾不能再次被取消；调用者仍须验证创建凭据及范围。 */
export function withoutMaintenanceTask<T>(work: () => T): T { return context.run(undefined, work) }

function taskIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const request = value as Record<string, unknown>
  if (Object.keys(request).length !== 1 || typeof request.taskId !== 'string'
    || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(request.taskId)) return
  return request.taskId
}
export interface MaintenanceTaskFailure { ok: false; code: string; detail: string; retryable: false }
export class MaintenanceTaskManager {
  private active?: Context
  private completed = new Map<string, MaintenanceTaskView>()
  constructor(private readonly onProgress?: (progress: MaintenanceTaskProgress) => void) {}
  get running(): boolean { return this.active !== undefined }
  get current(): MaintenanceTaskView | undefined { return this.active ? { ...this.active.view } : undefined }
  status(request: unknown): MaintenanceTaskStatus {
    const id = taskIdOf(request)
    if (!id) return { ok: false, code: 'INVALID_REQUEST' }
    const task = this.active?.view.taskId === id ? this.active.view : this.completed.get(id)
    return task ? { ok: true, task: { ...task } } : { ok: false, code: 'STALE_TASK' }
  }
  cancel(request: unknown): MaintenanceCancelResult {
    const id = taskIdOf(request)
    if (!id) return { ok: false, code: 'INVALID_REQUEST' }
    if (!this.active || this.active.view.taskId !== id) return { ok: false, code: 'STALE_TASK' }
    if (!this.active.view.cancellable) return { ok: false, code: 'NOT_CANCELLABLE' }
    this.active.view = { ...this.active.view, state: 'cancelling' }
    this.active.controller.abort()
    this.active.emit('已请求取消，正在等待安全点和资源收尾。')
    return { ok: true }
  }
  async run<T extends { ok: boolean; code?: string }>(kind: MaintenanceTaskKind, work: () => Promise<T>): Promise<T | MaintenanceTaskFailure> {
    const failure = (code: string): MaintenanceTaskFailure => ({ ok: false, code, detail: code === 'CANCELLED' ? '维护任务已在安全点停止。' : '维护任务未完成，原资料已保留。', retryable: false })
    if (this.active) return failure('TASK_BUSY')
    const current: Context = {
      controller: new AbortController(),
      view: { taskId: randomUUID(), kind, state: 'running', stage: 'starting', cancellable: true },
      emit: detail => { try { this.onProgress?.({ ...current.view, detail }) } catch { /* optional observation */ } }
    }
    this.active = current
    current.emit('维护任务已开始。')
    let result: T | MaintenanceTaskFailure
    try {
      result = await context.run(current, work)
      // 不把被下游catch吞掉的取消变成成功；清理失败保持其明确错误码。
      if (current.cleanupFailed && result.code !== 'STAGING_CLEANUP_FAILED') result = failure('TASK_CLEANUP_FAILED')
      else if (current.controller.signal.aborted && !['STAGING_CLEANUP_FAILED', 'TASK_CLEANUP_FAILED'].includes(result.code ?? '')) result = failure('CANCELLED')
    } catch (error) {
      const code = (error as { code?: string })?.code
      result = failure(current.cleanupFailed ? 'TASK_CLEANUP_FAILED' : code && ['STAGING_CLEANUP_FAILED', 'TASK_CLEANUP_FAILED'].includes(code) ? code : current.controller.signal.aborted ? 'CANCELLED' : 'TASK_FAILED')
    }
    current.view = { ...current.view, state: result.ok ? 'done' : result.code === 'CANCELLED' ? 'cancelled' : 'failed', cancellable: false }
    current.emit(result.ok ? '维护任务已完成。' : result.code === 'CANCELLED' ? '维护任务已取消并完成资源收尾。' : '维护任务未完成，请查看结果。')
    this.completed.set(current.view.taskId, { ...current.view })
    while (this.completed.size > 20) this.completed.delete(this.completed.keys().next().value!)
    this.active = undefined
    return result
  }
}
