/**
 * 自检报告模型与纯逻辑骨架（I6 批次 4 · T01）。
 *
 * 本任务（T01）**只放类型与骨架**：
 * - 类型（`DoctorSeverity` / `DoctorCheck` / `DoctorReport`）在**共享契约** `shared/workspaceBackupContracts.ts`
 *   中定义（渲染层要消费它们），此处 **import 并 re-export**——**只此一处定义**，避免两处漂移。
 * - 纯函数 `summarize(checks)`：把逐项结论汇总为计数（**不是评分**，对齐 D-038）。
 *
 * ⚠️ `buildDoctorReport(deps)`（C1–C4 只读聚合）由 **T02** 在本文件实现（见文件末尾）。
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
import { readRegistryOverview } from './registryView'
import { verifyBackup } from './verify'
import { listRestoreArchives } from './restoreMain'
import { checkRestoredAssetsIntegrity } from './assetsIntegrity'
import { redactText } from './redact'
import { scanArchives, DOCTOR_ARCHIVE_CHECK_ID } from './doctorArchiveScan'
import { scanSpaces, readRegistrySpacePaths, DOCTOR_SPACE_CHECK_ID, type SpacePathView } from './doctorSpaceScan'
import { listResidualStagingRoots, scanResiduals } from './doctorResidual'
// 归档目录收口为共享常量（I6 批次 3.5 · T01）：与 maintenanceMain / retention 同一事实源。
import { archiveDirectory } from './directories'
import { inspectResearchIntegrity } from '../library/research/integrity'
import { inspectPlanningIntegrity } from '../researchPlanning/integrity'
import { inspectLibraryIntegrity } from '../library/integrity'
import { inspectEditingIntegrity } from '../libraryEditing/integrity'

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

/* -------------------------------------------------------------------------- *
 * T02 · 只读自检聚合（C1–C4）
 * -------------------------------------------------------------------------- */

/** 稳定检查 id（C1 注册表可读）。 */
export const DOCTOR_REGISTRY_CHECK_ID = 'REGISTRY_READABLE'

/** 自检进度回调载荷（**不含本机绝对路径**；只报阶段与文案）。 */
export interface DoctorProgress {
  readonly stage: string
  readonly detail: string
}

/**
 * 自检依赖（全部可注入，便于隔离 IO 与做失败降级单测）。
 *
 * 生产调用方**无需**传任何可选字段——缺省即为真实只读原语（`verifyBackup` /
 * `checkRestoredAssetsIntegrity` / `listRestoreArchives` / `readRegistrySpacePaths`）。
 */
export interface DoctorDeps {
  /** 本机数据根（`~`）。 */
  readonly home: string
  /** 归档目录；缺省 `archiveDirectory(home)`（共享常量 `ARCHIVE_DIRECTORY_NAME`）。 */
  readonly archiveDir?: string
  /** 进度回调（每维开始前调用一次；detail **不含路径**）。 */
  readonly onProgress?: (p: DoctorProgress) => void
  /** 注册表只读概览（缺省 `readRegistryOverview`）；**抛错 → C1 `error`**。 */
  readonly readRegistry?: (home: string) => Array<{ id: string; name: string }>
  /** 归档候选列举（缺省 `listRestoreArchives`）。 */
  readonly listArchives?: (dir: string) => Promise<Array<{ path: string; name: string }>>
  /** 单份归档验包（缺省 `verifyBackup`）。 */
  readonly verifyArchive?: (path: string) => Promise<unknown>
  /** 单空间 `assets.db` 完整性校验（缺省 `checkRestoredAssetsIntegrity`）。 */
  readonly checkSpaceIntegrity?: (dbPath: string) => Promise<void>
  /**
   * 空间路径解析（**只读**，缺省 `readRegistrySpacePaths`）；`null` = 无法定位 → C3 降级 `notice`。
   * ⚠️ 生产缺省实现**绝不**调 `loadStore()`（设计稿 K3 红线）。
   */
  readonly resolveSpaces?: (home: string) => SpacePathView[] | null
  /** 残留暂存根扫描（缺省 `listResidualStagingRoots`）；返回残留暂存根的**基名**数组。 */
  readonly scanResiduals?: (home: string) => Promise<string[]> | string[]
}

/**
 * 跑完四维只读自检，产出结构化 `DoctorReport`。
 *
 * 四维（严格对齐设计稿 §1.2）：
 * - **C1 `REGISTRY_READABLE`**：`readRegistryOverview(home)` 只读读注册表；抛错 → `error`，
 *   但**其余维仍尽力跑**（一个失败绝不吞掉整份报告）。
 * - **C2 `ARCHIVE_VERIFY`**：对归档目录**每一份**归档调 `verifyBackup`；单份失败 → `warning`。
 * - **C3 `SPACE_INTEGRITY`**：对**每个已登记空间**的 `assets.db` 调 `checkRestoredAssetsIntegrity`；
 *   单空间失败 → `warning`（记录空间**名**非路径）。无法定位空间库 → `notice`。
 * - **C4 `RESIDUAL_ARTIFACTS`**：扫 `RESTORE_STAGING_PREFIX` 残留暂存根；发现 → `notice`。
 *
 * **只读红线**：C1–C4 **不取锁、不建目录、不写文件**。
 * **脱敏红线**：所有 `check.detail` **不含本机绝对路径**（产出前经 `redactText` 兜底过滤）。
 *
 * @param deps 自检依赖（`home` 必传，其余可注入；缺省走真实只读原语）。
 * @returns 结构化报告：`{ at, checks, summary }`。
 */
export async function buildDoctorReport(deps: DoctorDeps): Promise<DoctorReport> {
  const home = deps.home
  const archiveDir = deps.archiveDir ?? archiveDirectory(home)
  const readRegistry = deps.readRegistry ?? readRegistryOverview
  const listArchives = deps.listArchives ?? listRestoreArchives
  const verifyArchive = deps.verifyArchive ?? verifyBackup
  const checkSpaceIntegrity = deps.checkSpaceIntegrity ?? checkRestoredAssetsIntegrity
  const resolveSpaces = deps.resolveSpaces ?? readRegistrySpacePaths
  const residualScanner = deps.scanResiduals ?? listResidualStagingRoots
  const checks: DoctorCheck[] = []

  // ---- C1 注册表可读 ----
  deps.onProgress?.({ stage: 'doctor', detail: '正在检查注册表…' })
  let registryOk = false
  let registryNote = ''
  try {
    const spaces = readRegistry(home)
    registryOk = true
    checks.push({
      id: DOCTOR_REGISTRY_CHECK_ID,
      title: '注册表可读',
      severity: 'ok',
      detail: `本机注册表可读，共登记 ${spaces.length} 个空间。`,
      facts: { spaces: spaces.length }
    })
  } catch (error) {
    registryOk = false
    registryNote = '注册表不可读，空间相关检查已跳过'
    checks.push({
      id: DOCTOR_REGISTRY_CHECK_ID,
      title: '注册表可读',
      severity: 'error',
      detail: '本机注册表不可读（格式非法或无法访问）。',
      facts: { spaces: 0 }
    })
    // C1 error 不中断：其余维仍尽力跑（设计 §1.3）。
    void error
  }

  // ---- C2 归档验包 ----
  deps.onProgress?.({ stage: 'doctor', detail: '正在检查归档…' })
  try {
    const archives = await listArchives(archiveDir)
    checks.push(await scanArchives(archives, verifyArchive))
  } catch (error) {
    // 归档列举本身失败（非单份验包失败）→ 该项 warning，不吞报告。
    checks.push({
      id: DOCTOR_ARCHIVE_CHECK_ID,
      title: '归档验包',
      severity: 'warning',
      detail: '归档目录无法列举，跳过逐份验包。',
      facts: { total: 0, verified: 0, failed: 0 }
    })
    void error
  }

  // ---- C3 空间库完整性 ----
  deps.onProgress?.({ stage: 'doctor', detail: '正在检查空间资产库…' })
  let researchSpaces: SpacePathView[] | null = null
  if (!registryOk) {
    // 注册表不可读 → 无法定位空间 → C3 降级 notice，并明示跳过原因（设计 §1.3）。
    checks.push({
      id: DOCTOR_SPACE_CHECK_ID,
      title: '空间库完整性',
      severity: 'notice',
      detail: registryNote + '。',
      facts: { total: 0, ok: 0, failed: 0 }
    })
  } else {
    let spaces: SpacePathView[] | null = null
    try {
      spaces = resolveSpaces(home)
    } catch {
      // 空间路径解析失败（注册表条目非法）→ 无法定位 → C3 降级 notice（绝不 loadStore）。
      spaces = null
    }
    checks.push(await scanSpaces(spaces, checkSpaceIntegrity))
    researchSpaces = spaces
  }

  for (const space of researchSpaces ?? []) {
    const editing = inspectEditingIntegrity(space.path)
    checks.push({ id: 'LIBRARY_EDITING_INTEGRITY', title: '文献编辑恢复草稿',
      severity: editing.state === 'invalid' || editing.state === 'unsupported' ? 'error' : editing.state === 'warning' ? 'warning' : editing.state === 'unused' ? 'notice' : 'ok',
      detail: `${redactText(space.name || space.id)}：${editing.state === 'unused' ? '尚无恢复草稿' : editing.state === 'valid' ? '恢复草稿可解析' : editing.code ?? '存在失联或回收文献关联，输入保留'}；草稿${editing.draftCount}，未解析${editing.unresolvedCount}。`,
      facts: { drafts: editing.draftCount, unresolved: editing.unresolvedCount }
    })
    const library = inspectLibraryIntegrity(space.path)
    checks.push({ id: 'LIBRARY_INTEGRITY', title: '文献日期与回收站',
      severity: library.state === 'invalid' ? 'error' : library.state === 'unused' ? 'notice' : 'ok',
      detail: `${redactText(space.name || space.id)}：${library.state === 'invalid' ? '文献元信息损坏或不兼容，原资料保留' : library.state === 'unused' ? '尚无文献数据' : '日期与回收状态可解析'}；活动${library.active}，回收${library.trashed}。`,
      facts: { active: library.active, trashed: library.trashed }
    })
    const planning = inspectPlanningIntegrity(space.path)
    checks.push({ id: 'PLANNING_INTEGRITY', title: '科研计划完整性',
      severity: planning.state === 'invalid' || planning.state === 'unsupported' ? 'error' : planning.state === 'warning' ? 'warning' : planning.state === 'unused' ? 'notice' : 'ok',
      detail: `${redactText(space.name || space.id)}：${planning.state === 'unused' ? '尚未使用科研计划；如预期已有资料请核对备份' : planning.state === 'valid' ? '业务、草稿和提醒可解析' : planning.code ?? '存在失联关联，原记录保留'}；记录${planning.itemCount}，草稿${planning.draftCount}，提醒${planning.deliveryCount}，未解析${planning.unresolvedCount}。`,
      facts: { items: planning.itemCount, drafts: planning.draftCount, deliveries: planning.deliveryCount, unresolved: planning.unresolvedCount }
    })
    const result = inspectResearchIntegrity(space.path)
    const name = redactText(space.name || space.id)
    checks.push({
      id: 'RESEARCH_INTEGRITY', title: '研究问题与素材完整性',
      severity: result.state === 'invalid' || result.state === 'unsupported' ? 'error' : result.state === 'warning' ? 'warning' : result.state === 'unused' ? 'notice' : 'ok',
      detail: `${name}：${result.state === 'unused' ? '未找到研究组织文件，可能尚未使用；如预期已有资料请核对备份' : result.state === 'valid' ? '研究历史及引用可解析' : result.code === 'EVIDENCE_MISSING' ? '证据文件缺失（EVIDENCE_MISSING），研究引用保留，请核对备份' : result.code ?? '存在未解析关联'}；问题${result.questionCount}组，素材${result.packCount}包，未解析${result.unresolvedCount}项。验包保全原字节不等于业务引用健康。`,
      facts: { questions: result.questionCount, packs: result.packCount, unresolved: result.unresolvedCount }
    })
  }

  // ---- C4 残留暂存根 ----
  deps.onProgress?.({ stage: 'doctor', detail: '正在检查残留暂存根…' })
  try {
    const residuals = await residualScanner(home)
    checks.push(scanResiduals(residuals))
  } catch (error) {
    checks.push({
      id: 'RESIDUAL_ARTIFACTS',
      title: '残留暂存根',
      severity: 'notice',
      detail: '残留暂存根扫描未能完成，已跳过。',
      facts: { found: 0 }
    })
    void error
  }

  // 脱敏兜底：所有 detail 再过一道 redactText（防任何绝对路径片段外泄）。
  const safeChecks: DoctorCheck[] = checks.map((check) => ({
    ...check,
    detail: redactText(check.detail)
  }))

  return {
    at: new Date().toISOString(),
    checks: safeChecks,
    summary: summarize(safeChecks)
  }
}
