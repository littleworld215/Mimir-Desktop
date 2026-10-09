import { readFile, unlink } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as pause } from 'node:timers/promises'

export interface ManualStepOptions { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }

export function manualSessionTimeout(stepwise: boolean): number { return (stepwise ? 30 : 15) * 60_000 }

/** 仅启动下一次合成请求，不授予任何资产写入批准。 */
export async function waitForManualStep(controlFile: string, step: number, options: ManualStepOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000, pollMs = options.pollMs ?? 100
  if (!Number.isSafeInteger(step) || step < 1 || step > 7 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000 || !Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > 1000) throw Error('无效人工步骤或等待预算')
  const deadline = performance.now() + timeoutMs
  const check = () => {
    if (options.signal?.aborted) throw Error('人工步骤等待已取消')
    if (performance.now() >= deadline) throw Error('等待开始人工步骤超时')
  }
  while (true) {
    check()
    let content: string | undefined
    try { content = await readFile(controlFile, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    check()
    if (content !== undefined) {
      if (content.trim() !== String(step)) throw Error('非当前步骤的继续指令')
      await unlink(controlFile)
      check()
      return
    }
    await pause(Math.min(pollMs, Math.max(1, deadline - performance.now())))
  }
}
