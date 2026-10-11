/**
 * 自检报告模型与纯逻辑骨架（I6 批次 4 · T01）。
 *
 * 本任务（T01）**只放类型与骨架**：
 * - 类型（`DoctorSeverity` / `DoctorCheck` / `DoctorReport`）在**共享契约** `shared/workspaceBackupContracts.ts`
 *   中定义（渲染层要消费它们），此处 **import 并 re-export**——**只此一处定义**，避免两处漂移。
 * - 纯函数 `summarize(checks)`：把逐项结论汇总为计数（**不是评分**，对齐 D-038）。
 *
 * ⚠️ `buildDoctorReport(home, deps)`（C1–C4 只读聚合）是 **T02** 的范围，**不在本任务**实现。
 *
 * 纪律沿袭：
 * - `DoctorCheck.detail` **不含本机绝对路径 / 凭据**（承接批次 3 `restoreMain.ts:305` 的泄漏教训）。
 * - 报告只陈述**技术事实**：四级严重度 + 逐项结论 + 计数，**绝不**汇总成「健康分」。
 */

// 类型定义在共享契约（渲染层消费），此处 re-export 供主进程内部以统一入口引用。
export type {
  DoctorSeverity,
  DoctorCheck,
  DoctorReport
} from '../../shared/workspaceBackupContracts'

import type { DoctorCheck, DoctorReport } from '../../shared/workspaceBackupContracts'

/** 汇总计数形状（`DoctorReport.summary` 的具名别名，供 `summarize` 返回值标注）。 */
export type DoctorSummary = DoctorReport['summary']

/**
 * 汇总逐项检查的严重度为计数。
 *
 * **纯函数**：不修改入参，返回新对象。计数**不是**评分——只用于 UI 概览（避免 D-038 的
 * 「替用户做科研判断」）。空数组返回全零。
 *
 * @param checks 逐项检查结论（可为空数组）。
 * @returns `{ ok, notice, warning, error }` 四类计数，全部为非负整数。
 */
export function summarize(checks: DoctorCheck[]): DoctorSummary {
  const summary: DoctorSummary = { ok: 0, notice: 0, warning: 0, error: 0 }
  if (!Array.isArray(checks)) return summary
  for (const check of checks) {
    switch (check.severity) {
      case 'ok':
        summary.ok += 1
        break
      case 'notice':
        summary.notice += 1
        break
      case 'warning':
        summary.warning += 1
        break
      case 'error':
        summary.error += 1
        break
      default:
        // 未知严重度不应出现（类型已收口）；保守起见不计入任何桶，避免污染概览。
        break
    }
  }
  return summary
}
