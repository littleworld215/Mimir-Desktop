/**
 * 通用脱敏（I6 批次 4 · T01，纯函数）。
 *
 * 职责：把「待记录/待上报」的数据结构里的**两类敏感信息**在一个地方收口：
 * 1. **本机绝对路径** → 只保留 **basename**（或整段替换为根别名，见调用侧）；
 * 2. **敏感键名**（token/key/secret/password/credential/authorization）→ **整个键从对象中剔除**。
 *
 * 设计纪律（对齐 `docs/design/I6-BATCH4-DOCTOR-AUDIT.md` §2.2）：
 * - **纯函数、无副作用、不修改入参**：返回全新结构，绝不原地改写。
 * - **只 import `node:path`**（用 `basename` / `isAbsolute`）：不 import `fs`，不做任何 IO，
 *   因此可被单测在任意平台直接加载。
 * - **复用 `remapRules.isAbsolutePathLike`** 判定「像绝对路径」，而不是重造轮子：该函数是纯函数、
 *   零 import，且已正确处理 URL（`http://…` → `false`）与 UNC（明确 `false`），`redact.test.ts`
 *   里已锁定「URL 不被误伤」这条边界。
 *
 * ⚠️ **关于「绝对路径 → basename 会丢失父目录信息」——这是刻意的**：
 * 审计/自检详情的用途是「知道**改动了哪个文件**」，而**不需要**知道它在磁盘上的**位置**。
 * 父目录往往包含用户名、课题名、本地盘符等可识别信息，属于本批明确要收敛的暴露面。
 * 因此这里宁可牺牲「父目录上下文」，换取「零本机路径外泄」。若某条业务确实需要位置信息，
 * 应改用**根别名**（`<space-root>` / `<home>`）而非回填真实路径（见 §2.2 表格）。
 */

import { isAbsolutePathLike } from './remapRules'

/**
 * 平台无关的 basename：同时把 `\` 与 `/` 都当分隔符。
 *
 * 不直接用 `node:path.basename` 的原因：win32 语义下 `/` 与 `\` 都是分隔符，但 **POSIX 语义下
 * `\` 不是分隔符**——于是 `basename('D:\\a\\b.pdf')` 在 POSIX 上会**原样返回整串**（父目录信息
 * 根本没被剥掉，等于没脱敏）。单测在 POSIX 下也会因此失败。审计条目可能来自任意平台，
 * 因此这里做**平台无关**的剥离：统一按 `[\\/]` 切分取最后一段，两种分隔符都收敛。
 */
function platformAgnosticBasename(value: string): string {
  const segments = value.split(/[\\/]/)
  return segments[segments.length - 1] ?? ''
}

/**
 * 敏感键名表（**大小写不敏感、包含匹配**）。
 *
 * 命中任一子串的**键**会连同其值**整个从输出对象中移除**（不是替换为占位符——移除更彻底，
 * 杜绝「占位符里又塞了原值」这类二次泄漏）。
 *
 * ⚠️ 本表是「凭据零落盘/零上报」这条红线的**唯一开关**：`redact.test.ts` 里有一条
 * 「凭据键值绝不出现在输出中」的断言，并做变异验证（临时清空本表 → 该断言必须变红）。
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'token',
  'key',
  'secret',
  'password',
  'credential',
  'authorization'
]

/** 键名是否命中敏感表（大小写不敏感、包含匹配）。 */
export function isSensitiveKey(key: string): boolean {
  if (typeof key !== 'string' || key === '') return false
  const lowered = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lowered.includes(pattern))
}

/** 类型守卫：值是可继续下降的容器（数组或**普通**对象）。数组单独判，避免与对象混淆。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数组向下递归：逐元素脱敏（元素命中敏感键的剔除只发生在对象层，数组元素本身保留）。 */
function redactArray(value: unknown[]): unknown[] {
  return value.map((item) => redactValue(item))
}

/** 对象向下递归：剔除敏感键，其余值的递归脱敏结果挂到新对象上（不改入参）。 */
function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue // 敏感键：整个键从输出中移除
    output[key] = redactValue(item)
  }
  return output
}

/**
 * 递归脱敏一个任意值。
 *
 * - 字符串：若「像绝对路径」（`isAbsolutePathLike`）则替换为 `basename`（URL 不受影响）；
 * - 数组：逐元素递归；
 * - 普通对象：剔除敏感键名，其余值递归；
 * - 其余（数字/布尔/null/undefined/函数等）：原样返回。
 *
 * **纯函数**：不修改入参，返回新结构。
 *
 * ⚠️ 绝对路径 → basename 会**丢失父目录信息**，这是**刻意的**（见文件头注释）。
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (isAbsolutePathLike(value)) return platformAgnosticBasename(value)
    return value
  }
  if (Array.isArray(value)) return redactArray(value)
  if (isPlainObject(value)) return redactObject(value)
  return value
}

/**
 * 把一段**自由文案**里的绝对路径样**片段**替换为基名（用于 detail / progress 类文案）。
 *
 * 与 `redactValue` 的区别：`redactValue` 处理「整串就是一个路径」的场景，本函数处理
 * 「路径混在中文文案里」的场景（如 `归档内旧空间根：D:\a\b` 里的 `D:\a\b`）。
 *
 * 实现：用正则**在整个文案里**扫出「像绝对路径的片段」并就地替换为 basename。
 * 两条片段形态：
 *   1. Windows：盘符 + `\`/`/` + 非空白串（`D:\a\b`、`C:/科研/a.pdf`）；
 *   2. POSIX：`/` 开头的非空白串（`/home/u/a.pdf`）。
 * 为避免误伤 URL，V8 的 lookbehind 要求 Windows 片段前不是 `\w`（挡住 `https://` 里的 `//`），
 * 而 POSIX 片段用 `(?<![:\w/])` 同理挡住协议头。
 *
 * **纯函数**：不修改入参。
 *
 * ⚠️ 同样**刻意**丢弃父目录信息（见文件头注释）。
 */
export function redactText(text: string): string {
  if (typeof text !== 'string' || text === '') return text
  // 片段匹配顺序：Windows 盘符片段 / POSIX 片段。
  // - 整体前置断言 `(?<!\w)`：盘符片段的前一字符不得是词字符——否则 `https://` 里的 `s:` 会被
  //   当成盘符 `s:`（URL 协议尾被误伤）。
  // - Windows：`[A-Za-z]:[\\/]` + 路径体（`\` 或 `/` 分隔的非空白、非中文标点串）。
  // - POSIX：前导 `/`，**前置断言** `(?<![:\w/])` 排除：`://`（URL 协议尾）、`\w/`（词内斜杠，
  //   如 `and/or`）、`//`（URL 作者路径段）——这些都不是本机绝对路径。
  const fragmentPattern = /(?<!\w)(?:[A-Za-z]:[\\/][^\s,，;；()（）[\]{}"'“”‘’《》|]*|(?<![:\w/])\/[^\s,，;；()（）[\]{}"'“”‘’《》|]*)/g
  return text.replace(fragmentPattern, (fragment) => {
    if (!isAbsolutePathLike(fragment)) return fragment
    const base = platformAgnosticBasename(fragment)
    // basename 为空（如片段就是根 `/` 或 `C:\`）时保留一个安全占位，避免交给下游空串。
    return base === '' ? '<root>' : base
  })
}
