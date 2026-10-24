/**
 * 自检 C3 · 已登记空间 `assets.db` 完整性（I6 批次 4 · T02）。
 *
 * 职责（**单一**）：对**每个已登记空间**的 `assets.db` 调 `checkRestoredAssetsIntegrity`
 * （已 `readonly:true`），把 fail-fast 的抛错**在调用侧**收敛为逐项结论，并**记录空间「名」（非路径）**。
 *
 * 设计纪律（对齐 `docs/design/I6-BATCH4-DOCTOR-AUDIT.md` §1.2 C3 / §7 K3 / §7 K10）：
 * - **只读**：`checkRestoredAssetsIntegrity` 内部 `readonly:true`（设计 §1.2 明文）；本模块
 *   **不取锁、不建目录、不写文件**。
 * - **不改抛错语义**：`checkRestoredAssetsIntegrity` 失败即抛（`RestoreError`），本批不动它；
 *   doctor 在调用侧 `try/catch`，单空间失败只降为该项 `warning`。
 * - **记录空间名，非路径**：`DoctorCheck.detail` 只含空间 `name`（承接 §0.3 脱敏教训）。
 * - **⚠️ 空间根路径的只读获取（对应设计稿 K3 红线）**：`readRegistryOverview` 为「不 loadStore」
 *   刻意只返回 `{id,name}`（`registryView.ts:12/:32`），**不含 path**。本模块因此**自实现一个只读
 *   注册表解析器** `readRegistrySpacePaths(home)`：它**逐字照抄** `registryView.ts` 的防御式读法
 *   （lstat 校验 + 体积上限 + 逐条校验 + `isAbsolute(path)`），**只多保留 `path` 字段**。
 *   这条路径**完全只读**，**绝不调 `loadStore()`**（它会迁移/建默认空间/写指针）。
 *   若注册表不可读 / 条目非法 / 解析不到 path，则 C3 **降级为 `notice`**（「无法定位空间库」），
 *   并如实说明依据——**绝不为了拿 path 去写盘**。
 */

import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { DoctorCheck } from '../../shared/workspaceBackupContracts'
import { redactText } from './redact'
import { extractErrorCode } from './doctorArchiveScan'

/** 稳定检查 id。 */
export const DOCTOR_SPACE_CHECK_ID = 'SPACE_INTEGRITY'

/** 一个已登记空间的**只读**视图（含根路径，仅用于定位 `assets.db`；**不进 detail**）。 */
export interface SpacePathView {
  readonly id: string
  readonly name: string
  /** 空间根（绝对路径）。**绝不**进入任何 detail / 审计。 */
  readonly path: string
}

/** `lstat` 容错读取（`ENOENT` → `undefined`，其余错误上抛；抄 `registryView.entry`）。 */
function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * **只读**解析本机注册表，取出每个空间的 `{id, name, path}`（不 loadStore、不写盘）。
 *
 * ⚠️ 与 `readRegistryOverview` 的**唯一**差异：多保留 `path`（后者刻意丢弃）。
 * 防御式校验**逐字对齐** `registryView.ts:13-33`，任一非法即抛 `REGISTRY_INVALID`，
 * 由调用方（`scanSpaces`）捕获并降级为 `notice`。
 *
 * @param home 本机数据根（`~`）。
 * @returns 空间视图数组（含绝对 `path`）；注册表不存在时返回 `[]`。
 * @throws Error `REGISTRY_INVALID`：注册表目录/文件形态非法，或某条目非法。
 */
export function readRegistrySpacePaths(home: string): SpacePathView[] {
  const directory = join(home, '.mimir')
  const path = join(directory, 'store.json')
  const control = lstatOrUndefined(directory)
  if (!control) return []
  if (!control.isDirectory() || control.isSymbolicLink()) throw Error('REGISTRY_INVALID')
  const file = lstatOrUndefined(path)
  if (!file) return []
  if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024 * 1024) throw Error('REGISTRY_INVALID')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('REGISTRY_INVALID')
  const spaces = (value as Record<string, unknown>)['workspaces:list']
  if (spaces === undefined) return []
  if (!Array.isArray(spaces) || spaces.length > 100_000) throw Error('REGISTRY_INVALID')
  const ids = new Set<string>()
  return spaces.map((space) => {
    if (!space || typeof space !== 'object') throw Error('REGISTRY_INVALID')
    const record = space as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) throw Error('REGISTRY_INVALID')
    if (typeof record.name !== 'string') throw Error('REGISTRY_INVALID')
    if (typeof record.path !== 'string' || !isAbsolute(record.path)) throw Error('REGISTRY_INVALID')
    if (ids.has(record.id)) throw Error('REGISTRY_INVALID')
    ids.add(record.id)
    return { id: record.id, name: record.name, path: record.path }
  })
}

/**
 * 对每个已登记空间的 `assets.db` 做完整性校验，汇总为一条 `DoctorCheck`。
 *
 * - 无空间 → `ok`（「未登记任何空间」）。
 * - 全部通过 → `ok`。
 * - 有失败 → `warning`，detail 逐条列出「空间名（错误码）」，**记录名非路径**。
 * - 无法定位空间库（`spaces === null`）→ `notice`（降级，注明依据）。
 *
 * @param spaces 空间视图数组；`null` 表示**无法定位**（注册表不可读/非法），触发降级 `notice`。
 * @param checkIntegrity 完整性校验函数（生产为 `checkRestoredAssetsIntegrity`，测试可注入假实现）。
 * @returns 单条 `DoctorCheck`（`detail` 已脱敏，不含绝对路径）。
 */
export async function scanSpaces(
  spaces: SpacePathView[] | null,
  checkIntegrity: (dbPath: string) => Promise<void>
): Promise<DoctorCheck> {
  if (spaces === null) {
    return {
      id: DOCTOR_SPACE_CHECK_ID,
      title: '空间库完整性',
      severity: 'notice',
      detail: '注册表不可读或条目非法，无法定位空间库，空间相关检查已跳过。',
      facts: { total: 0, ok: 0, failed: 0 }
    }
  }

  if (spaces.length === 0) {
    return {
      id: DOCTOR_SPACE_CHECK_ID,
      title: '空间库完整性',
      severity: 'ok',
      detail: '注册表未登记任何空间，无需校验空间库。',
      facts: { total: 0, ok: 0, failed: 0 }
    }
  }

  const failures: Array<{ name: string; code: string }> = []
  let okCount = 0
  for (const space of spaces) {
    // 实际资产域路径仅用于定位，绝不进入detail。
    const dbPath = join(space.path, '.mimir', 'assets', 'assets.db')
    const safeName = redactText(space.name || space.id)
    try {
      await checkIntegrity(dbPath)
      okCount += 1
    } catch (error) {
      failures.push({ name: safeName, code: extractErrorCode(error, 'INTEGRITY_FAILED') })
    }
  }

  if (failures.length === 0) {
    return {
      id: DOCTOR_SPACE_CHECK_ID,
      title: '空间库完整性',
      severity: 'ok',
      detail: `已校验 ${spaces.length} 个空间资产库，全部通过。`,
      facts: { total: spaces.length, ok: okCount, failed: 0 }
    }
  }

  const listed = failures.map((item) => `${item.name}（${item.code}）`).join('、')
  return {
    id: DOCTOR_SPACE_CHECK_ID,
    title: '空间库完整性',
    severity: 'warning',
    detail: `共 ${spaces.length} 个空间，其中 ${failures.length} 个资产库未通过校验：${listed}。`,
    facts: { total: spaces.length, ok: okCount, failed: failures.length }
  }
}
