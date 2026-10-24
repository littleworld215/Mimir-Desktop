/** G-04已确认的结构路径元信息与纯路径边界匹配。实际授权由structuredPaths按对象结构定位，不能仅凭字段名改写未知数据。 */

/** 一条白名单例：空间层 `store.json` 的顶层键 + 字段名。 */
export interface RemapRule {
  /** 空间层 store 的顶层键（如 `library:papers`）。 */
  readonly storeKey: string
  /** 该键下、允许改写的字段名。 */
  readonly field: string
}

/** 已批准I6五类结构字段；不是对任意同名嵌套键的授权。 */
export const REMAP_WHITELIST = [
  { storeKey: 'library:papers', field: 'pdfPath' },
  { storeKey: 'library:projects', field: 'paperDir' },
  { storeKey: 'paper.recentProjects', field: 'dir' },
  { storeKey: 'chat:conversations', field: 'messages[].artifacts[].path' },
  { storeKey: 'chat:conversations', field: 'messages[].run.steps[].artifacts[]' }
] as const

/** 白名单字段名的字面量联合类型：包括已批准五类结构字段，用于类型层面的收口。 */
export type RemapWhitelistField = (typeof REMAP_WHITELIST)[number]['field']

/** 匹配/替换的可选项（**显式**传入，避免隐式依赖运行环境）。 */
export interface RemapMatchOptions {
  /**
   * 路径比较是否忽略大小写。
   * 缺省：`win32` 为 `true`，其余平台为 `false`（与 Windows 文件系统语义一致）。
   */
  readonly caseInsensitive?: boolean
  /**
   * 拼接新值时使用的路径分隔符。缺省按平台取（win32 为 `\`，其余为 `/`）。
   * 单测建议显式传入以保证跨平台确定性。
   */
  readonly separator?: '\\' | '/'
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
const WINDOWS_DRIVE = /^[A-Za-z]:/
const POSIX_ABSOLUTE = /^\//

/** win32 平台默认（用于 `caseInsensitive` / `separator` 的缺省回落；不 import 任何模块）。 */
function isWin32(): boolean {
  return typeof process !== 'undefined' && process.platform === 'win32'
}

/** 缺全省略时的大小写敏感性：win32 忽略大小写，其余平台区分。 */
function defaultCaseInsensitive(): boolean {
  return isWin32()
}

/** 缺全省略时的分隔符：win32 用反斜杠，其余平台用正斜杠。 */
function defaultSeparator(): '\\' | '/' {
  return isWin32() ? '\\' : '/'
}

/**
 * 判断字符串是否「像绝对路径」。
 *
 * - Windows：盘符 + 分隔符（`C:\a`、`C:/a`）；
 * - POSIX：前导 `/`；
 * - URL（`http://…`）、相对路径、空串一律 `false`（URL 绝不能被当成路径改写）。
 *
 * 注：UNC（`\\server\share`）不在本批范围内，明确返回 `false`。
 */
export function isAbsolutePathLike(value: string): boolean {
  if (typeof value !== 'string' || value === '') return false
  return WINDOWS_ABSOLUTE.test(value) || POSIX_ABSOLUTE.test(value)
}

/** 统一为正斜杠（便于跨形态比较与下标计算，不改变长度）。 */
function toSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * 纯字符串版的 `path.resolve()`：归一化为「盘符 + 正斜杠 + 无尾部分隔符」的形态，
 * 并折叠 `.` / `..` / 重复分隔符。
 *
 * 不 import `node:path` 的原因：`resolve()` 会读 `process.cwd()`，让「纯函数」带上环境耦合；
 * 本函数只做字符串归一化，结果在任何平台/目录下都一致。
 */
function resolvePathLike(value: string): string {
  const raw = toSlashes(typeof value === 'string' ? value : '')
  const drive = /^([A-Za-z]:)\/*/.exec(raw)
  const absolute = raw.startsWith('/')
  const body = drive !== null ? raw.slice(drive[0].length) : absolute ? raw.slice(1) : raw
  const segments: string[] = []
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  if (drive !== null) return `${drive[1]}/${joined}`
  return absolute ? `/${joined}` : joined
}

/**
 * 归一化「根」用于前缀比较：`resolve()` 后去掉尾部分隔符，并按 `caseInsensitive` 小写化。
 *
 * @example normalizeRootForMatch('/a/b/', { caseInsensitive: false }) === '/a/b'
 */
export function normalizeRootForMatch(root: string, opts: RemapMatchOptions = {}): string {
  const normalized = resolvePathLike(root)
  const caseInsensitive = opts.caseInsensitive ?? defaultCaseInsensitive()
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/** 类型守卫：值是可继续下降的容器（数组或普通对象）。 */
export function isContainerOfUnknown(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (typeof value === 'object' && value !== null)
}

/**
 * 判断 `value` 是否落在 `oldRoot` 之下（**路径边界匹配**）。
 *
 * 命中条件（两者皆须满足）：
 * 1. `oldRoot` 与 `value` 都像绝对路径；
 * 2. `value` **等于** `oldRoot`，或以「`oldRoot` + 分隔符」开头。
 *
 * 因此老根 `/a/b` 时，`/a/bc/papers/x.pdf` 与 `/a` 都**不命中**——这是防误伤的关键边界。
 */
export function matchRootPrefix(
  value: string,
  oldRoot: string,
  opts: RemapMatchOptions = {}
): { matched: boolean; rest: string | null } {
  if (typeof value !== 'string' || typeof oldRoot !== 'string') return { matched: false, rest: null }
  if (!isAbsolutePathLike(oldRoot) || !isAbsolutePathLike(value)) return { matched: false, rest: null }

  const caseInsensitive = opts.caseInsensitive ?? defaultCaseInsensitive()
  const oldNormalized = normalizeRootForMatch(oldRoot, { caseInsensitive })
  // 根退化为空串（相对根）：拒绝匹配——否则「空前缀 + 分隔符」会把任意绝对路径都算作命中。
  if (oldNormalized === '') return { matched: false, rest: null }

  const valueNormalized = resolvePathLike(value)
  const valueCompared = caseInsensitive ? valueNormalized.toLowerCase() : valueNormalized

  if (valueCompared === oldNormalized) return { matched: true, rest: '' }
  const prefix = oldNormalized.endsWith('/') ? oldNormalized : `${oldNormalized}/`
  if (valueCompared.startsWith(prefix)) {
    return { matched: true, rest: valueNormalized.slice(prefix.length) }
  }
  return { matched: false, rest: null }
}

/**
 * 把 `value` 的 `oldRoot` 前缀替换成 `newRoot`（用平台/指定分隔符拼接）。
 *
 * @returns 命中返回新值；未命中返回 `null`（调用方据此「原样保留」）。
 */
export function replaceRootPrefix(
  value: string,
  oldRoot: string,
  newRoot: string,
  opts: RemapMatchOptions = {}
): string | null {
  const matched = matchRootPrefix(value, oldRoot, opts)
  if (!matched.matched || matched.rest === null) return null

  const separator = opts.separator ?? defaultSeparator()
  const newNormalized = resolvePathLike(newRoot).replace(/\//g, separator)
  const rest = matched.rest.replace(/\//g, separator)
  if (rest === '') return newNormalized
  return newNormalized.endsWith(separator) ? `${newNormalized}${rest}` : `${newNormalized}${separator}${rest}`
}
