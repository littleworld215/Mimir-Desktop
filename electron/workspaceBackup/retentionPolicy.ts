/**
 * 归档保留策略（纯函数，I6 批次 5 · T01）。
 *
 * 职责：把一批**已通过白名单**的归档按策略分成「保留」与「清理候选」，并算出可释放字节。
 *
 * ── 铁律（对齐设计 §1.2 / D-032） ─────────────────────────────────────────
 * 1. **纯函数**：绝不修改入参（返回全新结构），**绝不删除任何东西**。真正的删除是另一个
 *    显式动作（`retentionService` 的 `applyRetention`），且必须经用户二次确认。
 * 2. **不校验/不过滤文件名**：白名单在**扫描层**（`archiveScan.listManagedArchives`）。
 *    本函数**信任输入已过滤**——从调用两侧保证非白名单文件永不进入本层（§1.2 末尾）。
 * 3. **零后台**：本模块没有定时器 / 启动钩子；它只在你**主动调用**时算一个计划出来。
 */

/** 保留策略。 */
export interface RetentionPolicy {
  /** 保留最新份数（**固定 20**，固定边界明文）。 */
  readonly keep: number
  /** 保护窗口：N 天内一律保留（可选加固；默认 0 = 不启用）。 */
  readonly keepDays?: number
}

/** 一个候选归档（服务层持有绝对路径；**路径不进 UI**）。 */
export interface RetentionCandidate {
  /** 绝对路径（**仅服务层用**，不进 UI）。 */
  readonly path: string
  /** 文件名。 */
  readonly name: string
  /** 字节数。 */
  readonly bytes: number
  /** 最后修改时刻（ISO 字符串，排序键）。 */
  readonly modifiedAt: string
}

/** 保留原因：`recent` = 落在最新 N 份内；`within-days` = 落在天数保护窗口内。 */
export type RetentionKeepReason = 'recent' | 'within-days'
/** 清理候选原因（当前仅一种）。 */
export type RetentionRemoveReason = 'beyond-keep'

/** 保留项（附原因）。 */
export type RetentionKept = RetentionCandidate & { readonly reason: RetentionKeepReason }
/** 清理候选（附原因）。 */
export type RetentionRemovable = RetentionCandidate & { readonly reason: RetentionRemoveReason }

/** 保留计划（**只报告，不删**）。 */
export interface RetentionPlan {
  /** 保留项（含原因：`recent` / `within-days`），按 `modifiedAt` 降序。 */
  readonly keep: RetentionKept[]
  /** 清理候选（**最早**先删；附原因），按 `modifiedAt` 降序（末尾为最早）。 */
  readonly candidates: RetentionRemovable[]
  /** 可释放字节合计（= 候选字节之和）。 */
  readonly reclaimableBytes: number
}

/**
 * 按策略把归档分成「保留」与「清理候选」，**绝不删除任何东西**。
 *
 * 规则（设计 §1.2）：
 * - 按 `modifiedAt` **降序**排序（最新在前，不修改入参数组）。
 * - 排在前 `keep` 份的 → `recent` 保留。
 * - `keepDays > 0` 且 `now - modifiedAt <= keepDays` 的 → `within-days` 保留。
 * - 其余 → `candidates`（`reason: 'beyond-keep'`）。
 * - `reclaimableBytes` = 候选字节合计。
 *
 * 排序说明：返回的 `keep` / `candidates` 均保持降序；`candidates` 末尾即**最早**的一份，
 * 清理执行时会**先删最早**（对齐设计 §2.2 步骤 ④）。
 *
 * @param archives 候选归档（**必须已通过白名单**，见本模块头注释铁律 2）。
 * @param policy 保留策略。
 * @param now 参考时刻（**注入以便单测**；缺省 = 当前时刻）。
 * @returns 全新 `RetentionPlan`（入参对象与数组均未被修改）。
 */
export function planRetention(
  archives: readonly RetentionCandidate[],
  policy: RetentionPolicy,
  now: Date = new Date()
): RetentionPlan {
  // `[...archives]` 复制后再排序：绝不修改入参数组（纯函数纪律 1）。
  const sorted = [...archives].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))

  const keep: RetentionKept[] = []
  const candidates: RetentionRemovable[] = []

  // `keep` 归一化为非负整数（防御 NaN / 负数；不改策略语义，只做安全钳制）。
  const keepCount = Number.isFinite(policy.keep) && policy.keep > 0 ? Math.floor(policy.keep) : 0
  const keepDays = typeof policy.keepDays === 'number' && policy.keepDays > 0 ? policy.keepDays : 0
  /** `within-days` 边界：`now - keepDays * 1天`；`keepDays === 0` 时不参与判定。 */
  const windowStartMs = keepDays > 0 ? now.getTime() - keepDays * 24 * 60 * 60 * 1000 : 0

  sorted.forEach((candidate, index) => {
    if (index < keepCount) {
      // 落在最新 N 份内。
      keep.push({ ...candidate, reason: 'recent' })
      return
    }
    if (keepDays > 0) {
      const modifiedMs = Date.parse(candidate.modifiedAt)
      if (Number.isFinite(modifiedMs) && modifiedMs >= windowStartMs) {
        keep.push({ ...candidate, reason: 'within-days' })
        return
      }
    }
    candidates.push({ ...candidate, reason: 'beyond-keep' })
  })

  const reclaimableBytes = candidates.reduce((sum, item) => sum + item.bytes, 0)

  return { keep, candidates, reclaimableBytes }
}
