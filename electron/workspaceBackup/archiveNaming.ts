/**
 * 归档命名规范（I6 批次 5 · T01）。
 *
 * 职责：把「整空间归档」的文件名规则定义成**唯一事实源**。保留策略（`retentionPolicy.ts`）
 * 的白名单、只读扫描（`archiveScan.ts`）的过滤、以及将来打包接线（T03）都从本模块取规则，
 * 从而保证「什么是本应用产出的归档」只有一个定义。
 *
 * 命名形态：`mimir-backup-<空间名slug>-<YYYYMMDD-HHMMSS>.zip`
 *
 * ── 为什么**不用** UUID 名（对齐设计 §1.1） ───────────────────────────────
 * 批次 2 的暂存名 `backup-<uuid>.zip.partial` 用了 UUID。保留策略需要**可解析的时间** +
 * **可识别的空间**来做两件事：
 *   1. 「按时间保留最新 20 份」——需要能从文件名解析出创建时刻（排序键）；
 *   2. 用户可读的预览——需要识别这是哪个空间的归档。
 * UUID 两者都给不了（时间不可解析、空间不可读）。
 * `.partial` 是**暂存名**（打包中、尚未发布），发布名才是上面的最终名；因此保留策略
 * **绝不匹配 `.partial`**（见 `archiveScan.ts` 的显式排除，以及本模块正则的 `.zip$` 锚点）。
 *
 * ── 时间戳为什么是**本地时间**（对齐批次 4 `auditWriter`） ──────────────
 * 本地 `YYYYMMDD-HHMMSS` 与 D-032 的 `\d{8}-\d{6}` 同构、人可读，且与批次 4 的审计分片
 * 文件名（`maintenance-audit-<本地 YYYY-MM-DD>.jsonl`）保持**同一日期口径**。若这里改用 UTC，
 * 同一台机器上「审计说今天、归档说昨天」的错位会出现，用户对照预览时会被误导。
 *
 * 本模块**零副作用**：纯字符串 ↔ 正则 ↔ `Date` 变换，不触碰文件系统。
 */

/**
 * 归档文件名模式。
 *
 * 捕获组 `[1]` = 空间名 slug（1–64 个 `[a-z0-9-]`），`[2]` = 本地时间戳 `YYYYMMDD-HHMMSS`。
 * 首尾锚点（`^` / `$`）是**保留策略安全的关键**：去锚点会让 `foo-mimir-backup-....zip.bak`
 * 之类的名字误入白名单（K1 误删不可变快照的根源），故本模式**必须**保留锚点。
 */
export const ARCHIVE_FILE_PATTERN = /^mimir-backup-([a-z0-9-]{1,64})-(\d{8}-\d{6})\.zip$/

/** slug 最大长度（设计 §1.1：裁到 64 字符，与正则的 `{1,64}` 对齐）。 */
const SLUG_MAX_LENGTH = 64
/** slug 为空时的兜底值（保证正则恒可匹配，不留「无 slug」的歧义形态）。 */
const SLUG_FALLBACK = 'space'

/**
 * 把空间名 slug 化：小写 → 非 `[a-z0-9]` 折为 `-` → 压缩连续 `-` → 去首尾 `-` → 裁 64。
 *
 * **空结果兜底为 `'space'`**：否则空名 / 全特殊字符名会产出 `mimir-backup--<ts>.zip`
 * 这类无法被 `ARCHIVE_FILE_PATTERN` 匹配的形态，破坏「`deriveArchiveName` 与模式互逆」这条
 * 契约。兜底保证 `isManagedArchive(deriveArchiveName(n, d)) === true` 恒成立。
 *
 * @param spaceName 原始空间名（任意 Unicode）。
 * @returns 满足 `[a-z0-9-]{1,64}` 的 slug（非空）。
 */
function slugify(spaceName: string): string {
  const lowered = spaceName.toLowerCase()
  // 非 [a-z0-9] 一律折为 `-`（中文 / 标点 / 空格 / 下划线都归一到分隔符）。
  const dashed = lowered.replace(/[^a-z0-9]/g, '-')
  // 压缩连续 `-` 后去首尾 `-`。
  const collapsed = dashed.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '')
  // 裁到 64 字符后再去一次尾 `-`（裁剪可能恰好切在分隔符上）。
  const trimmed = collapsed.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '')
  return trimmed === '' ? SLUG_FALLBACK : trimmed
}

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 把 `Date` 格式化为**本地**时间戳 `YYYYMMDD-HHMMSS`。
 *
 * ⚠️ 刻意用本地时间（`getFullYear`/`getMonth`… 而非 `getUTC*`）：口径理由见本文件头注释。
 *
 * @param at 时刻。
 * @returns 8 位日期 + `-` + 6 位时间。
 */
function formatLocalTimestamp(at: Date): string {
  const yyyy = String(at.getFullYear()).padStart(4, '0')
  const mm = pad2(at.getMonth() + 1)
  const dd = pad2(at.getDate())
  const hh = pad2(at.getHours())
  const mi = pad2(at.getMinutes())
  const ss = pad2(at.getSeconds())
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

/**
 * 由空间名 + 时钟生成归档文件名（纯函数，供打包接线使用）。
 *
 * 与 `ARCHIVE_FILE_PATTERN` **互逆**：`isManagedArchive(deriveArchiveName(n, d)) === true`，
 * 且 `archiveTimestamp(deriveArchiveName(n, d))` 能还原到同一分钟（秒精度，本地时区）。
 *
 * @param spaceName 空间名（任意 Unicode；空 / 全特殊字符时 slug 兜底为 `space`）。
 * @param at 生成时刻（本地时区用于时间戳）。
 * @returns 形如 `mimir-backup-my-space-20240102-030405.zip`。
 */
export function deriveArchiveName(spaceName: string, at: Date): string {
  const slug = slugify(spaceName)
  const stamp = formatLocalTimestamp(at)
  return `mimir-backup-${slug}-${stamp}.zip`
}

/**
 * 判定一个文件名是否是本应用产出的归档（保留策略白名单的**唯一**入口）。
 *
 * ⚠️ 只认**完整文件名**（含 `.zip` 后缀、无路径分隔）。调用方应传 basename；即便传了
 * 含路径的字符串，`^...$` 锚点也会因路径分隔符而拒绝（不会漏判）。
 *
 * @param fileName 待判定的文件名。
 * @returns 是受管归档 → `true`。
 */
export function isManagedArchive(fileName: string): boolean {
  return ARCHIVE_FILE_PATTERN.test(fileName)
}

/**
 * 从归档名解析出时间戳（供保留策略排序；解析失败 → `null`）。
 *
 * 解析出的时刻按**本地时区**构造（与 `formatLocalTimestamp` 对称）；秒精度。
 *
 * @param fileName 归档文件名。
 * @returns 解析成功 → `Date`；不匹配模式或日期非法（如 `20241340-...`）→ `null`。
 */
export function archiveTimestamp(fileName: string): Date | null {
  const match = ARCHIVE_FILE_PATTERN.exec(fileName)
  if (match === null) return null
  const stamp = match[2] // `YYYYMMDD-HHMMSS`
  const year = Number(stamp.slice(0, 4))
  const month = Number(stamp.slice(4, 6))
  const day = Number(stamp.slice(6, 8))
  const hour = Number(stamp.slice(9, 11))
  const minute = Number(stamp.slice(11, 13))
  const second = Number(stamp.slice(13, 15))
  const date = new Date(year, month - 1, day, hour, minute, second)
  // 拒绝「溢出滚动」的非法日期：`new Date(2024, 12, 40)` 会静默滚到次年，必须显式挡掉。
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null
  }
  return date
}
