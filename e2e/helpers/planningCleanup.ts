export interface PlanningCleanupOptions {
  discard(): Promise<boolean>
  close(): Promise<void>
  timeoutMs?: number
  pollMs?: number
}

type CleanupStage = 'discard' | 'close'
class PlanningCleanupTimeout extends Error {
  readonly code = 'PLANNING_CLEANUP_TIMEOUT'
  constructor(readonly stage: CleanupStage) {
    super(`Synthetic planning cleanup timed out during ${stage}; no close retry or forced termination was attempted`)
    this.name = 'PlanningCleanupTimeout'
  }
}

/** Only the planning background spec opts in; product guards and the shared fixture stay unchanged. */
export async function cleanupPlanningTest(options: PlanningCleanupOptions): Promise<void> {
  const deadline = performance.now() + (options.timeoutMs ?? 5000)
  async function beforeDeadline<T>(run: () => Promise<T>, stage: CleanupStage): Promise<T> {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new PlanningCleanupTimeout(stage)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PlanningCleanupTimeout(stage)), remaining)
      // Observe late completion/rejection without retrying or treating a timeout as cancellation.
      Promise.resolve().then(() => {
        if (performance.now() >= deadline) throw new PlanningCleanupTimeout(stage)
        return run()
      }).then(value => {
        clearTimeout(timer)
        if (performance.now() >= deadline) reject(new PlanningCleanupTimeout(stage))
        else resolve(value)
      }, error => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }
  while (!await beforeDeadline(options.discard, 'discard')) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new PlanningCleanupTimeout('discard')
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(options.pollMs ?? 50, remaining)))
  }
  await beforeDeadline(options.close, 'close')
}

export interface PlanningContextCleanupOptions extends PlanningCleanupOptions {
  exitedNormally(): boolean
  release(): void
}

/** Release is deliberately outside the in-flight close: late completion after timeout must retain evidence. */
export async function cleanupPlanningContext(options: PlanningContextCleanupOptions): Promise<void> {
  await cleanupPlanningTest(options)
  if (!options.exitedNormally()) {
    throw Object.assign(new Error('Synthetic planning process normal exit is unconfirmed; temporary files retained'), {
      code: 'PLANNING_CLEANUP_EXIT_UNCONFIRMED'
    })
  }
  options.release()
}
