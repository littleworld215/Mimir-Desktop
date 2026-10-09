import type { WorkspaceOperationGate } from './operationGate'
import { performance } from 'node:perf_hooks'

interface HandoffPorts {
  gate: WorkspaceOperationGate
  timeoutMs: number
  cancelApprovals(): Promise<void>
  stopProducers(): Promise<void>
  closeMcp(): Promise<void>
  closeManagedProcesses(): Promise<void>
  closeAssets(): Promise<void>
  launchMaintenance(): void
}

/** 必须先经过已有窗口卸载守卫；超时只阻断，不能让迟到回调启动新写者。 */
export class MaintenanceHandoff {
  state: 'idle' | 'requested' | 'draining' | 'blocked' | 'handedOver' = 'idle'
  constructor(private readonly ports: HandoffPorts) {}
  request() {
    if (this.state !== 'idle') throw Error('维护交接已经开始。')
    this.state = 'requested'
  }
  cancel() {
    if (this.state === 'requested') this.state = 'idle'
  }
  async windowClosed() {
    if (this.state !== 'requested') throw Error('未请求维护，或交接已经结束。')
    this.state = 'draining'
    this.ports.gate.stopAccepting()
    const deadline = performance.now() + this.ports.timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const ensureActive = () => {
      if (this.state !== 'draining' || performance.now() >= deadline) throw Error('维护交接已失效。')
    }
    const cleanup = async () => {
      // 开始排空即保留所有在途任务的结果，不能漏掉关闭MCP期间结束的任务。
      const drained = this.ports.gate.drain(this.ports.timeoutMs)
      void drained.catch(() => {})
      for (const step of [this.ports.cancelApprovals, this.ports.stopProducers, this.ports.closeMcp]) {
        ensureActive()
        await step.call(this.ports)
      }
      ensureActive()
      await drained
      ensureActive()
      await this.ports.closeManagedProcesses()
      ensureActive()
      await this.ports.closeAssets()
      ensureActive()
    }
    try {
      await Promise.race([
        cleanup(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('TIMEOUT')), this.ports.timeoutMs) })
      ])
      ensureActive()
      // 最终端口只同步安排relaunch/退出；不得在此另启异步清理或放行第二写者。
      this.ports.launchMaintenance()
      this.state = 'handedOver'
    } catch {
      this.state = 'blocked'
      throw Error('维护交接失败；未授予新写者，需确认资源已退出后重试。')
    } finally {
      clearTimeout(timer)
    }
  }
}
