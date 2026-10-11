/**
 * 恢复暂存根（I6 批次 3 · 第 2 块）。
 *
 * 职责：管理「本次操作」的暂存根目录的**创建、占用与清理**。暂存根与目标**同父目录**
 * （保证发布是一次同盘 `rename`，不跨卷），以 `.` 开头且不进任何清单。
 *
 * 纪律（对应设计 §2.1 / §2.2 / §1.3 规则 2）：
 * - **独占创建**：用 `wx`（独占）语义，已存在即失败——不复用别人的暂存根。
 * - **清理只限本次产物**：`cleanup()` 的清理范围由 `abortScope()` 给出，
 *   **绝不**触碰原空间根 / 原注册表 / 其它空间。
 * - 本模块只做目录级操作，**不解压、不校验**（那是 `extract.ts` 的职责）。
 */

import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { RestoreError, RESTORE_STAGING_PREFIX } from './restoreContracts'
import { abortScope } from './restoreState'

export interface StagingRoot {
  /** 暂存根绝对路径。 */
  readonly root: string
  /** 是否由本会话创建（仅自建才允许清理）。 */
  readonly owned: boolean
}

/** 由目标路径推导暂存根路径（与 `restorePlan.planRestore` 口径一致：同父目录）。 */
export function stagingPathFor(targetRoot: string, token: string): string {
  const normalized = targetRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) throw new RestoreError('INVALID_TARGET', `目标路径缺少父目录：${targetRoot}`)
  const parent = normalized.slice(0, index)
  return `${parent}/${RESTORE_STAGING_PREFIX}${token}`
}

/**
 * 创建本次暂存根（独占）。
 *
 * 为保证「同盘 rename」，父目录（=目标父目录）必须已存在；此处**不**新建父目录，
 * 由调用方（T04 编排）在完成本机磁盘校验后提供。
 *
 * @throws RestoreError `STAGING_CONFLICT`（已存在）| `INVALID_TARGET`（父目录不存在）
 */
export function createStagingRoot(targetRoot: string, token: string): StagingRoot {
  const root = stagingPathFor(targetRoot, token)
  if (existsSync(root)) {
    throw new RestoreError('STAGING_CONFLICT', `暂存根已存在，拒绝复用：${root}`)
  }
  const parent = root.slice(0, root.lastIndexOf('/'))
  if (!existsSync(parent)) {
    throw new RestoreError('INVALID_TARGET', `暂存根父目录不存在（须先做磁盘校验）：${parent}`)
  }
  try {
    // 独占创建：`recursive:false` + 已存在即抛。
    mkdirSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RestoreError('STAGING_CONFLICT', `暂存根已存在，拒绝复用：${root}`)
    }
    throw new RestoreError('STAGING_CLEANUP_FAILED', `暂存根创建失败：${root}（${(error as Error).message}）`)
  }
  return { root, owned: true }
}

/**
 * 清理本次暂存根（只限本操作产物）。
 *
 * 清理范围由 `abortScope()` 推导——**绝不**自行拼接路径、**绝不**触碰原空间/原注册表。
 *
 * @throws RestoreError `STAGING_CLEANUP_FAILED` 当目录仍存在且删除失败
 */
export function cleanupStagingRoot(stagingRoot: string, options: { createdTarget?: string | null } = {}): void {
  // 经 abortScope 统一「本操作产物」口径：失败阶段用 failed 以满足其契约。
  const scope = abortScope(
    { stage: 'failed', code: 'EXTRACT_FAILED', retryable: true, detail: '清理暂存根' },
    { stagingRoot, createdTarget: options.createdTarget ?? null }
  )
  for (const target of [scope.stagingRoot, scope.createdTarget]) {
    if (target === null) continue
    // 安全兜底：只清理以暂存前缀命名的目录，拒绝误删任意路径。
    if (!target.split('/').pop()!.startsWith(RESTORE_STAGING_PREFIX) && target !== scope.createdTarget) {
      throw new RestoreError('STAGING_CLEANUP_FAILED', `拒绝清理非暂存目录：${target}`)
    }
    if (!existsSync(target)) continue
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (error) {
      throw new RestoreError('STAGING_CLEANUP_FAILED', `暂存清理失败：${target}（${(error as Error).message}）`)
    }
  }
}
