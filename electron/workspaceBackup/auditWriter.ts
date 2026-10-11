/**
 * 脱敏审计落盘（I6 批次 4 · T03）。
 *
 * 职责：把一条**已白名单形状**的维护审计条目（`MaintenanceAuditEntry`）**只追加**到
 * 本机数据目录内的按天分片 JSONL：`~/.mimir/logs/maintenance-audit-<YYYY-MM-DD>.jsonl`。
 *
 * 落盘纪律（对齐 `docs/design/I6-BATCH4-DOCTOR-AUDIT.md` §2.1 的 S-A1..S-A4）：
 *
 * - **S-A1 原子追加**：用 `openSync(path,'a',0o600)` + `writeSync` **单行追加**：
 *   O_APPEND 语义下内核保证同一 `write` 调用的整行落在文件末尾，崩溃最多丢**半行**，
 *   下一行起仍可解析。**刻意不用** temp+rename——审计是**追加流**，rename 会整文件替换，
 *   与并发读/并发追加之间产生丢数据的窗口（与 `registryAppend.ts` 的整文件原子写范式**不同**，
 *   那里是「全量替换一个有界 JSON」，这里是「只往末尾堆一行」）。
 * - **S-A2 权限 0600**：文件以 `0o600` 打开（新建即生效）；win32 无 POSIX 权限位，跳过 chmod
 *   （对齐 `registryAppend.ts` 的 `tightenFileMode` 思路）。
 * - **S-A3 失败仅告警**：**整函数包 try/catch**，任何失败（磁盘满 / 权限 / 路径非法）都只
 *   `console.warn` 后**返回**，**绝不上抛**——审计是尽力而为的旁路，绝不能拖垮被审计的
 *   维护动作本身（对齐 `permissionService.recordAudit`，也是设计稿风险 K6 的缓解）。
 * - **S-A4 绝不记录正文/凭据**：写盘前对 entry 再跑一道 `redactValue` **兜底**。
 *   但注意 `MaintenanceAuditEntry` 是**白名单形状**（无自由字段），类型上就没有放正文/凭据
 *   的位置，`redactValue` 在此主要是「防调用方在 `labels` 里漏塞路径 / 在 `counts` 里夹带
 *   敏感键」的第二道防线。本 writer **不提供**「附加任意字段」的口子（签名只收 entry 形状）。
 *
 * 落点目录（`~/.mimir/logs/`）**只在首次写入时** `mkdirSync(dir,{recursive:true})`：
 * 读路径（`auditReader.ts`）绝不建目录，写路径才建——保持「读零副作用」的纪律。
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import type { MaintenanceAuditEntry } from '../../shared/workspaceBackupContracts'
import { redactValue } from './redact'

/** 数据目录名（本机，非空间层），与注册表 `<home>/.mimir/` 同根。 */
const MIMIR_DIR_NAME = '.mimir'
/** 审计子目录名。 */
const LOGS_DIR_NAME = 'logs'
/** 审计文件前缀；后缀为 `<YYYY-MM-DD>.jsonl`（本批与 D-069 的 `backup-prune-<日期>.jsonl` 同构）。 */
const AUDIT_FILE_PREFIX = 'maintenance-audit-'
/** 审计文件固定按凭据模式 0600（与注册表一致）。 */
const CREDENTIAL_FILE_MODE = 0o600

/**
 * 把日期格式化为审计分片的 `YYYY-MM-DD`（**本地日期**，非 UTC）。
 *
 * 用**本地日期**而非 `toISOString().slice(0,10)` 的理由：审计文件是给**人**看的、
 * 按「用户所在时区的一天」切片的。若用 UTC，东八区用户在凌晨 08:00 之前写审计会被归到
 * **前一天**的文件里，出现「今天看不到今天的审计」的困惑。本地日期符合直觉。
 */
function formatDateStamp(date: Date): string {
  const year = date.getFullYear()
  // getMonth() 从 0 起；补零到两位。
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 审计目录（`<home>/.mimir/logs`）。 */
function auditDir(home: string): string {
  return join(home, MIMIR_DIR_NAME, LOGS_DIR_NAME)
}

/**
 * 审计文件路径（按天分片）。
 *
 * @param home 用户 home 目录（本机数据根；`~/.mimir/logs/` 落于此下）。
 * @param date 决定分片文件名的日期（本地日期口径，见 `formatDateStamp`）。
 * @returns `<home>/.mimir/logs/maintenance-audit-<YYYY-MM-DD>.jsonl`
 */
export function maintenanceAuditPath(home: string, date: Date): string {
  return join(auditDir(home), `${AUDIT_FILE_PREFIX}${formatDateStamp(date)}.jsonl`)
}

/**
 * 追加一条维护审计（**尽力而为：失败仅 warn，绝不上抛**）。
 *
 * 步骤：① 写盘前 `redactValue` 兜底 ② `JSON.stringify` + `'\n'` 组**单行**
 * ③ 确保 `logs/` 存在（首次写入才建） ④ `openSync(path,'a',0o600)` ⑤ `writeSync` 整行追加
 * ⑥ 关闭 fd。
 *
 * 任何一步失败 → `console.warn('[maintenance-audit] 写审计失败', { code })` 后返回。
 *
 * @param home 用户 home 目录。
 * @param entry 白名单形状的审计条目（调用方已脱敏；此处再兜底一道）。
 */
export function appendMaintenanceAudit(home: string, entry: MaintenanceAuditEntry): void {
  try {
    // ① 兜底脱敏（纯函数，不改入参；返回新结构）。类型上 entry 已是白名单形状，此处防
    //    调用方在 labels/counts 里漏脱敏（如 labels 塞了绝对路径）。
    const safe = redactValue(entry) as MaintenanceAuditEntry

    // ② 单行 JSONL（每行一个 JSON 对象，`\n` 结尾）。
    const line = `${JSON.stringify(safe)}\n`
    const buffer = Buffer.from(line, 'utf8')

    // ③ 首次写入才建目录（读路径绝不建目录，写路径才建）。
    const dir = auditDir(home)
    mkdirSync(dir, { recursive: true })

    // ④⑤⑥ 追加写：open('a') 自带 O_APPEND；O_CREAT 由 'a' 隐含（不存在则创建）。
    //      权限 0600 在**新建时**生效；win32 无 POSIX 权限位，openSync 的 mode 参数被忽略，无需 chmod。
    const path = maintenanceAuditPath(home, new Date())
    const fd = openSync(path, 'a', CREDENTIAL_FILE_MODE)
    try {
      writeSync(fd, buffer)
    } finally {
      // 无论 writeSync 成败都必须关 fd（否则 fd 泄漏）。closeSync 失败也吞掉——不值得为此上抛。
      try {
        closeSync(fd)
      } catch {
        // 忽略：fd 关闭失败不影响「审计尽力而为」的语义。
      }
    }
  } catch (error) {
    // S-A3：绝不抛给调用方。只报错误码（不报完整路径，避免 warn 日志本身泄漏本机路径）。
    console.warn('[maintenance-audit] 写审计失败', { code: (error as { code?: unknown }).code })
  }
}
