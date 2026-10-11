/**
 * 自检 C4 · 残留暂存根扫描（I6 批次 4 · T02）。
 *
 * 职责（**单一**）：扫描自检根目录下以 `RESTORE_STAGING_PREFIX`
 * （`.mimir-restore-staging-`，`restoreContracts.ts:149`）开头的**残留暂存根**，发现则出 `notice`。
 *
 * 设计纪律（对齐 `docs/design/I6-BATCH4-DOCTOR-AUDIT.md` §1.2 C4 / §1.3）：
 * - **只读**：仅 `readdirSync(withFileTypes)` 列目录，**不删、不建、不写**。
 * - **只报数量 + 基名**：`DoctorCheck.detail` **绝不**含本机绝对路径（承接 §0.3）。
 * - **发现 → `notice`**（可清理，非错误），对齐 §1.3「C4 发现残留 → notice」。
 * - **不自动清理**：本模块**只报告**，任何清理都是另一个显式动作（本批不做）。
 */

import { readdirSync, type Dirent } from 'node:fs'
import type { DoctorCheck } from '../../shared/workspaceBackupContracts'
import { RESTORE_STAGING_PREFIX } from './restoreContracts'
import { redactText } from './redact'

/** 稳定检查 id。 */
export const DOCTOR_RESIDUAL_CHECK_ID = 'RESIDUAL_ARTIFACTS'

/**
 * 扫描一个目录下以 `RESTORE_STAGING_PREFIX` 开头的**残留暂存根**。
 *
 * ⚠️ **只读**：目录不存在 / 不可读一律返回 `[]`（不抛错——自检不能因一个不可读目录而崩）。
 * 只统计**目录**条目（暂存根是目录）；同名文件不算残留。
 *
 * @param root 扫描根（如 `home`）。
 * @returns 残留暂存根的**基名**数组（不含路径，已按 `readdirSync` 定义天然是基名，再经 redact 兜底）。
 */
export function listResidualStagingRoots(root: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    // 目录不存在 / 权限不足 / 并发删除：自检不因个别目录失败而中断，返回空。
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith(RESTORE_STAGING_PREFIX)) continue
    if (!entry.isDirectory()) continue
    found.push(redactText(entry.name))
  }
  return found.sort()
}

/**
 * 把残留暂存根扫描结果收敛为一条 `DoctorCheck`。
 *
 * - 无残留 → `ok`。
 * - 发现残留 → `notice`，只报**数量 + 基名**（不自动清理）。
 *
 * @param residuals 残留暂存根基名数组（来自 `listResidualStagingRoots` 或注入的假实现）。
 * @returns 单条 `DoctorCheck`（`detail` 已脱敏，不含绝对路径）。
 */
export function scanResiduals(residuals: readonly string[]): DoctorCheck {
  if (residuals.length === 0) {
    return {
      id: DOCTOR_RESIDUAL_CHECK_ID,
      title: '残留暂存根',
      severity: 'ok',
      detail: '未发现残留暂存根。',
      facts: { found: 0 }
    }
  }

  const listed = residuals.map((name) => redactText(name)).join('、')
  return {
    id: DOCTOR_RESIDUAL_CHECK_ID,
    title: '残留暂存根',
    severity: 'notice',
    detail: `发现 ${residuals.length} 个残留暂存根（${listed}），不自动清理，可在下一步手动确认清理。`,
    facts: { found: residuals.length }
  }
}
