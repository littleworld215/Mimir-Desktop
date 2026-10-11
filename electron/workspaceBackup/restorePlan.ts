/**
 * 新空间恢复计划（I6 批次 3 · 第 1 块，纯函数）。
 *
 * 职责：给定「归档验包结果 + 目标位置」，产出 `RestorePlan`（目标/暂存根/条目数/字节数），
 * 并执行设计 §2.1 的**落点不可覆盖**校验。
 *
 * 纪律：
 * - **零 IO**：不 stat、不 mkdir、不 rename。目标是否存在由调用方以 `targetExists` 布尔传入，
 *   暂存根路径由本函数**纯字符串推导**（`<targetParent>/.mimir-restore-staging-<token>`）。
 *   真正的存在性检查与创建留给 T02（解压）/ T04（发布）。
 * - `TARGET_EXISTS` 必须**真的拒绝**（不能只返回标志位），由测试断言。
 */

import { RestoreError, RESTORE_STAGING_PREFIX, type RestorePlan } from './restoreContracts'

/** 验包结果的**子集**（与 `verify.VerifyResult` 结构兼容，避免 import 产生循环）。 */
export interface VerifiedArchive {
  readonly entries: number
  readonly totalBytes: number
  readonly formatVersion: number
}

export interface PlanRestoreInput {
  /** 归档文件绝对路径。 */
  readonly archivePath: string
  /** 目标新空间根绝对路径（必须不存在）。 */
  readonly targetRoot: string
  /** 目标是否已存在（由调用方 stat 得到；T01 不 IO）。 */
  readonly targetExists: boolean
  /** 验包结果（来自批次 2 的 `verifyBackup`）。 */
  readonly verified: VerifiedArchive
  /** 暂存根唯一 token（通常为随机 uuid；注入以便测试确定性）。 */
  readonly stagingToken: string
}

/** 目标/归档路径必须是绝对路径（Windows 盘符或 POSIX 前导斜杠）。 */
function assertAbsolute(value: string, label: string): void {
  const normalized = value.replace(/\\/g, '/')
  const isAbs = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')
  if (!isAbs) throw new RestoreError('INVALID_TARGET', `${label} 必须是绝对路径：${value}`)
}

/** 取父目录（纯字符串，不 touch 文件系统）。 */
function parentOf(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return normalized
  // 保留盘符前缀（`C:/`）或 POSIX 根（`/`）。
  const head = normalized.slice(0, index)
  return /^[a-zA-Z]:$/.test(head) ? `${head}/` : head
}

/**
 * 生成恢复计划；目标已存在则抛 `TARGET_EXISTS`（**拒绝覆盖**，设计 §2.1/§2.3）。
 *
 * @throws RestoreError `TARGET_EXISTS` | `INVALID_TARGET`
 */
export function planRestore(input: PlanRestoreInput): RestorePlan {
  const { archivePath, targetRoot, targetExists, verified, stagingToken } = input
  assertAbsolute(archivePath, '归档路径')
  assertAbsolute(targetRoot, '目标空间路径')
  if (stagingToken.trim() === '') throw new RestoreError('INVALID_TARGET', '暂存 token 不能为空。')

  // 落点不可覆盖：这是**硬拒绝**，不提供合并/清空选项。
  if (targetExists) {
    throw new RestoreError('TARGET_EXISTS', `目标目录已存在，拒绝覆盖：${targetRoot}`)
  }

  // 暂存根与目标**同盘/同父目录**（保证发布是一次原子 rename，不跨卷）。
  const parent = parentOf(targetRoot)
  const stagingRoot = `${parent}/${RESTORE_STAGING_PREFIX}${stagingToken}`

  return {
    archivePath,
    targetRoot: targetRoot.replace(/\\/g, '/').replace(/\/+$/, ''),
    stagingRoot,
    entries: verified.entries,
    totalBytes: verified.totalBytes,
    formatVersion: verified.formatVersion
  }
}
