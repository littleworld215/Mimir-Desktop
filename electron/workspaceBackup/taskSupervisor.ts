import type { OperationScope, WorkspaceOperationGate } from './operationGate'

/** 一个生产入口的任务寿命；取消通知与真正完成分开，失败不冒充排空成功。 */
export class WorkspaceTaskSupervisor {
  private accepting = true
  private tasks = new Set<{ controller: AbortController; promise: Promise<unknown> }>()
  private stopping?: Promise<void>
  constructor(private readonly gate: WorkspaceOperationGate, private readonly capture: () => OperationScope) {}
  async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw Error('后台任务入口已关闭。')
    const controller = new AbortController()
    const promise = this.gate.run(this.capture(), async () => {
      // 在回调开始前先登记任务，避免同步停止遗漏刚被接受的任务。
      await Promise.resolve()
      return fn(controller.signal)
    })
    const task = { controller, promise }
    this.tasks.add(task)
    try { return await promise }
    finally { this.tasks.delete(task) }
  }
  async stop(): Promise<void> {
    if (this.gate.current()) throw Error('任务内不能等待自身停止。')
    if (this.stopping) return this.stopping
    this.accepting = false
    this.stopping = (async () => {
      const tasks = [...this.tasks]
      for (const task of tasks) task.controller.abort()
      const results = await Promise.allSettled(tasks.map(task => task.promise))
      if (results.some(result => result.status === 'rejected')) throw Error('后台任务未全部成功收口，不能授予交接。')
    })()
    return this.stopping
  }
}
