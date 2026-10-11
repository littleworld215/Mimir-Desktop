/**
 * 脱敏审计读取（I6 批次 4 · T03）。
 *
 * 职责：**只读**扫描本机数据目录内 `~/.mimir/logs/maintenance-audit-*.jsonl` 的分片，
 * 按**文件名日期倒序**累计最近 `limit` 条，返回**已脱敏**的 `MaintenanceAuditView`。
 *
 * 读取纪律（对齐 `docs/design/I6-BATCH4-DOCTOR-AUDIT.md` §2 / §4.3 / 风险 K8）：
 *
 * - **纯只读、零副作用**：`logs/` 目录不存在 → 直接返回空视图，**绝不** `mkdirSync`。
 *   （写路径才建目录；读路径建目录会违反「读零写」纪律。）
 * - **逐行 try/catch 容错**（K8）：JSONL 是追加流，崩溃可能留下**半行**截断。
 *   坏行（非 JSON / 非对象）**跳过并计数**，绝不让一行坏数据毁掉整个读取。
 * - **返回已脱敏条目**：每条读回后再跑一道 `redactValue` 兜底（历史文件可能是旧版本写的、
 *   或被人为编辑过；读取侧不假设文件内容一定干净）。
 * - **不暴露 JSONL 文件路径本身**：返回结构只有 `entries` / `skipped`，没有任何 `path` 字段
 *   （对齐 §4.3 裁剪纪律——路径是服务层内部概念）。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { MaintenanceAuditEntry, MaintenanceAuditView } from '../../shared/workspaceBackupContracts'
import { redactValue } from './redact'

/** 数据目录名（本机，非空间层）。 */
const MIMIR_DIR_NAME = '.mimir'
/** 审计子目录名。 */
const LOGS_DIR_NAME = 'logs'
/** 审计文件前缀（与 writer 保持单一事实源语义；后缀为 `<YYYY-MM-DD>.jsonl`）。 */
const AUDIT_FILE_PREFIX = 'maintenance-audit-'
/** 审计文件扩展名。 */
const AUDIT_FILE_SUFFIX = '.jsonl'
/** 缺省读取条数。 */
const DEFAULT_LIMIT = 50
/** 读取条数硬上限（钳制渲染层传入的任意 `limit`，避免一次读空全部历史）。 */
const MAX_LIMIT = 500

/** 审计目录（`<home>/.mimir/logs`）。 */
function auditDir(home: string): string {
  return join(home, MIMIR_DIR_NAME, LOGS_DIR_NAME)
}

/**
 * 断言文件名是「本 reader 认得的审计分片」：`maintenance-audit-<...>.jsonl`。
 *
 * 用前缀 + 后缀双判定，避免误把同目录的其它文件（如 writer 未来可能加的 `backup-prune-*.jsonl`
 * 或临时文件）当作审计分片读入。
 */
function isAuditFile(name: string): boolean {
  return name.startsWith(AUDIT_FILE_PREFIX) && name.endsWith(AUDIT_FILE_SUFFIX)
}

/**
 * 列出审计分片文件名，按**倒序**（新日期在前）。
 *
 * 分片名是 `maintenance-audit-<YYYY-MM-DD>.jsonl`：`YYYY-MM-DD` 是**字典序 == 时间序**的格式，
 * 故直接对同定长前缀后的文件名做**降序字符串比较**即可得到时间倒序，无需解析日期。
 * 长度不一致的异常名（非本前缀）已被 `isAuditFile` 挡掉，前缀等长故比较稳定。
 */
function listAuditFilesDesc(home: string): string[] {
  const dir = auditDir(home)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    // logs/ 不存在或不可读 → 无分片（不建目录、不上抛）。
    return []
  }
  return names.filter(isAuditFile).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

/**
 * 读单个分片文件的**行数组**（不去空行、不解析）。
 *
 * 读取失败（文件在 `readdir` 之后被删/权限变更）→ 返回 `[]`（该分片作废，不影响其它分片）。
 */
function readAuditFileLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return []
  }
}

/** 单行解析：合法 JSON 对象 → 返回；否则 → `null`（由调用方计为坏行跳过）。 */
function parseAuditLine(line: string): MaintenanceAuditEntry | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null // 半行截断 / 非法 JSON → 坏行（K8）。
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null // 顶层不是对象 → 坏行。
  }
  return parsed as MaintenanceAuditEntry
}

/**
 * 只读最近 N 条审计（跨天分片按时间倒序读取）。
 *
 * @param home 用户 home 目录（`~/.mimir/logs/` 落于此下）。
 * @param limit 期望读取条数（缺省 {@link DEFAULT_LIMIT}；钳制到 `[0, MAX_LIMIT]`）。
 * @returns `{ entries, skipped }`：`entries` 为已脱敏条目（新→旧），`skipped` 为跳过的坏行数。
 *
 * **只读**：不建目录、不写文件。`logs/` 不存在 → 返回空视图（`{ entries: [], skipped: 0 }`）。
 */
export function readRecentMaintenanceAudit(home: string, limit: number = DEFAULT_LIMIT): MaintenanceAuditView {
  // 钳制：非有限数 / 负数 / NaN → 0；超过硬上限 → 上限。杜绝渲染层传入 Infinity 之类读空整个历史。
  const effectiveLimit =
    Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_LIMIT) : 0
  if (effectiveLimit === 0) {
    return { entries: [], skipped: 0 }
  }

  const entries: MaintenanceAuditEntry[] = []
  let skipped = 0

  // 新日期分片在前：先读最新的，凑满 limit 即停——保证「最近 N 条」是**跨天**的最近 N 条。
  for (const name of listAuditFilesDesc(home)) {
    if (entries.length >= effectiveLimit) break
    const lines = readAuditFileLines(join(auditDir(home), name))
    // 同一文件内：写入顺序 == 时间顺序（追加流），故**从后往前**读，越靠后越新。
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i]
      if (raw === undefined) continue
      const parsed = parseAuditLine(raw)
      if (parsed === null) {
        // 空行（文件末尾换行产生的尾空串）不算「坏行」，不计数；其余无法解析的才计为跳过。
        if (raw.trim() !== '') skipped += 1
        continue
      }
      // 读取侧兜底脱敏（历史文件可能是旧版本写的或被人为编辑）。
      entries.push(redactValue(parsed) as MaintenanceAuditEntry)
      if (entries.length >= effectiveLimit) break
    }
  }

  return { entries, skipped }
}
