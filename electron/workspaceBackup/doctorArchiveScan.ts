/**
 * 自检 C2 · 归档逐份验包（I6 批次 4 · T02）。
 *
 * 职责（**单一**）：对归档目录里的**每一份**归档调用 `verifyBackup` 验包，并把
 * fail-fast 的抛错**在调用侧**收敛为逐项结论（`ok` / `warning`），**绝不让一份失败吞掉整份报告**。
 *
 * 设计纪律（对齐 `docs/design/I6-BATCH4-DOCTOR-AUDIT.md` §1.2 C2 / §7 K4）：
 * - **只读**：仅 `verifyBackup`（只读打开）与 `listRestoreArchives`（只读列目录）。
 * - **不改抛错语义**：`verifyBackup` 是批次 2 的既定契约（fail-fast 抛 `VerifyError(code)`），
 *   本批**不动它**；doctor 在调用侧 `try/catch`，把 `code` 映射为报告条目。
 * - **单份失败只降为该项 `warning`**，附**归档文件名（basename，经 `redactText`）**与**错误码**。
 * - **detail 不含本机绝对路径**：文件名一律经 `redactText` 过滤（承接 §0.3 的泄漏教训）。
 */

import { basename } from 'node:path'
import { maintenanceCheckpoint, checkMaintenanceCancellation } from './maintenanceTask'
import type { DoctorCheck } from '../../shared/workspaceBackupContracts'
import { redactText } from './redact'

/** 稳定检查 id（供 UI 与人话映射，不随文案变）。 */
export const DOCTOR_ARCHIVE_CHECK_ID = 'ARCHIVE_VERIFY'

/** 单份归档的验包结果事实（供 `facts` 计数，不含路径）。 */
export interface ArchiveVerifyOutcome {
  /** 归档文件名（basename，**已脱敏**）。 */
  readonly name: string
  /** 是否验包通过。 */
  readonly verified: boolean
  /** 失败时的错误码（SCREAMING_SNAKE，非自由文本）；通过时为 `''`。 */
  readonly code: string
}

/** 从任意异常里**安全**提取错误码：仅接受 `code` 为字符串者，否则回退到 `UNKNOWN`。 */
export function extractErrorCode(error: unknown, fallback = 'UNKNOWN'): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return fallback
}

/**
 * 对归档目录里的每一份归档逐份验包，汇总为一条 `DoctorCheck`。
 *
 * - 无归档 → `ok`（「未发现可校验的归档」）；**允许全绿就是全绿**（对齐 §1.3）。
 * - 全部通过 → `ok`，`facts.total` / `facts.verified`。
 * - 有失败 → `warning`，`facts.failed` 计数，detail 逐条列出「文件名（错误码）」。
 *
 * @param archives 归档候选（`{ path, name }`；`path` 仅用于验包，**不进 detail**）。
 * @param verify 验包函数（生产为 `verifyBackup`，测试可注入假实现）。
 * @returns 单条 `DoctorCheck`（`detail` 已脱敏，不含绝对路径）。
 */
export async function scanArchives(
  archives: ReadonlyArray<{ readonly path: string; readonly name: string }>,
  verify: (path: string) => Promise<unknown>,
  onScope?: (check: DoctorCheck) => void
): Promise<DoctorCheck> {
  const outcomes: ArchiveVerifyOutcome[] = []
  const coverage = { total: archives.length, declared: 0, unknown: 0, excluded: 0, external: 0, unresolved: 0 }
  for (const archive of archives) {
    await maintenanceCheckpoint()
    // 归档文件名一律以 basename 呈现，并再经 redactText 兜底（即便 name 被塞进绝对路径也不外泄）。
    const safeName = redactText(basename(archive.name || archive.path))
    try {
      const checked = await verify(archive.path)
      const scope = checked && typeof checked === 'object' && 'scope' in checked ? (checked as { scope: unknown }).scope : undefined
      const value = scope && typeof scope === 'object' ? scope as Record<string, unknown> : undefined
      if (value && (value.metadata === 'present' || value.metadata === 'legacy-unknown')
        && (value.coverage === 'unknown' || value.coverage === 'known-structured-fields')
        && ['excludedCount', 'externalCount', 'unresolvedCount'].every(k => Number.isSafeInteger(value[k]) && Number(value[k]) >= 0)) {
        if (value.metadata === 'present') coverage.declared++
        if (value.metadata === 'legacy-unknown' || value.coverage === 'unknown') coverage.unknown++
        coverage.excluded += Number(value.excludedCount); coverage.external += Number(value.externalCount); coverage.unresolved += Number(value.unresolvedCount)
      } else coverage.unknown++
      outcomes.push({ name: safeName, verified: true, code: '' })
    } catch (error) {
      checkMaintenanceCancellation()
      // ⚠️ 单份失败只降为该项 warning——绝不 catch 后上抛吞掉整份报告。
      outcomes.push({ name: safeName, verified: false, code: extractErrorCode(error, 'VERIFY_FAILED') })
      coverage.unknown++
    }
  }

  const total = outcomes.length
  const failed = outcomes.filter((outcome) => !outcome.verified)
  const verified = total - failed.length
  if (total > 0) onScope?.({ id: 'ARCHIVE_SCOPE', title: '归档覆盖范围',
    severity: coverage.excluded + coverage.external + coverage.unresolved > 0 ? 'warning' : coverage.unknown > 0 ? 'notice' : 'ok',
    detail: `范围声明可读${coverage.declared}份，覆盖未知${coverage.unknown}份；超限未纳入${coverage.excluded}项，已知外部引用${coverage.external}项，未解析${coverage.unresolved}项。内容验包与覆盖范围独立；只识别已知结构字段，不核实外部目标。`, facts: coverage })

  if (total === 0) {
    return {
      id: DOCTOR_ARCHIVE_CHECK_ID,
      title: '归档验包',
      severity: 'ok',
      detail: '未发现可校验的归档（归档目录为空或不存在）。',
      facts: { total: 0, verified: 0, failed: 0 }
    }
  }

  if (failed.length === 0) {
    return {
      id: DOCTOR_ARCHIVE_CHECK_ID,
      title: '归档验包',
      severity: 'ok',
      detail: `已逐份校验 ${total} 份归档，全部通过。`,
      facts: { total, verified, failed: 0 }
    }
  }

  const listed = failed.map((outcome) => `${outcome.name}（${outcome.code}）`).join('、')
  return {
    id: DOCTOR_ARCHIVE_CHECK_ID,
    title: '归档验包',
    severity: 'warning',
    detail: `共 ${total} 份归档，其中 ${failed.length} 份未通过校验：${listed}。`,
    facts: { total, verified, failed: failed.length }
  }
}
