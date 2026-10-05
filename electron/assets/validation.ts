/**
 * 资产域写入校验（**主进程专用，纯函数**）。
 *
 * 依据 INTEGRATION-PLAN-I0-I1 §3.3「写入限制」：上限是目标实现的明确默认，
 * 不静默截断——超限直接拒绝（`BAD_REQUEST`）。
 *
 * 注意：文件大小由主进程 stat / 流式计数验证，UI 预检查不能替代这里的服务检查。
 */

import {
  ASSET_CODE_MAX,
  ASSET_CONTENT_MAX_BYTES,
  ASSET_FILE_MAX_BYTES,
  ASSET_MAX_TAGS,
  ASSET_NAME_MAX,
  ASSET_SOURCE_JSON_MAX_BYTES,
  TAG_NAME_MAX
} from '../../shared/assetsContracts'
import type { StorageType, TemplateConfig, VariableInputType } from '../../shared/assetsContracts'

export class AssetsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetsValidationError'
  }
}

const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 名称：1–200 字，去首尾空白后非空，且不含 NUL。 */
export function assertAssetName(input: unknown): string {
  if (typeof input !== 'string') throw new AssetsValidationError('名称必须是字符串')
  const name = input.trim()
  if (name === '') throw new AssetsValidationError('名称不能为空')
  if (name.includes('\u0000')) throw new AssetsValidationError('名称不能包含 NUL 字符')
  if (name.length > ASSET_NAME_MAX) throw new AssetsValidationError(`名称不能超过 ${ASSET_NAME_MAX} 字`)
  return name
}

/** code：小写连字符，≤100 字。 */
export function assertAssetCode(input: unknown): string {
  if (typeof input !== 'string') throw new AssetsValidationError('code 必须是字符串')
  const code = input.trim()
  if (code === '' || code.length > ASSET_CODE_MAX || !CODE_RE.test(code)) {
    throw new AssetsValidationError('code 需为小写连字符形式（如 literature-note），且不超过 100 字')
  }
  return code
}

/** 标签显示名：1–80 字，不含逗号（沿用来源约定）与 NUL。 */
export function assertTagName(input: unknown): string {
  if (typeof input !== 'string') throw new AssetsValidationError('标签名必须是字符串')
  const name = input.trim()
  if (name === '') throw new AssetsValidationError('标签名不能为空')
  if (name.includes('\u0000')) throw new AssetsValidationError('标签名不能包含 NUL 字符')
  if (name.includes(',') || name.includes('，')) throw new AssetsValidationError('标签名不能包含逗号')
  if (name.length > TAG_NAME_MAX) throw new AssetsValidationError(`标签名不能超过 ${TAG_NAME_MAX} 字`)
  return name
}

/** 标签数量上限。 */
export function assertTagCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) throw new AssetsValidationError('标签数量非法')
  if (count > ASSET_MAX_TAGS) throw new AssetsValidationError(`单个资产最多 ${ASSET_MAX_TAGS} 个标签`)
}

/** 正文：≤5 MiB UTF-8（按字节计）。 */
export function assertContentBytes(content: unknown): string {
  if (typeof content !== 'string') throw new AssetsValidationError('正文必须是字符串')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > ASSET_CONTENT_MAX_BYTES) {
    throw new AssetsValidationError(`正文超过 ${Math.round(ASSET_CONTENT_MAX_BYTES / 1024 / 1024)} MiB 上限`)
  }
  return content
}

/** 文件字节上限（用于流式计数结果）。 */
export function assertFileBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) throw new AssetsValidationError('文件大小非法')
  if (bytes > ASSET_FILE_MAX_BYTES) {
    throw new AssetsValidationError(`文件超过 ${Math.round(ASSET_FILE_MAX_BYTES / 1024 / 1024)} MiB 上限`)
  }
}

/**
 * 正 safe integer id。
 *
 * 只接受两种形态，**绝不**做任意类型转换：
 * - `number`：必须为 safe integer 且 > 0；
 * - `string`：必须是纯十进制整数串（`/^\d+$/`）且转换后为 safe integer 且 > 0。
 *
 * 为什么不复用 `Number(input)`：`Number(true) === 1`、`Number([1]) === 1`、
 * `Number('') === 0`，会把 `true` / `[1]` 这类非法 IPC 参数「凑巧」转成合法 id，
 * 命中真实资产。boolean / array / object 等一律拒绝。
 */
export function assertPositiveId(input: unknown, label = 'id'): number {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input <= 0) throw new AssetsValidationError(`${label} 非法`)
    return input
  }
  if (typeof input === 'string') {
    // 仅接受十进制整数串：拒绝 '1.5' / '1e3' / '-1' / '' / ' 1 ' 等。
    if (!/^\d+$/.test(input)) throw new AssetsValidationError(`${label} 非法`)
    const n = Number(input)
    if (!Number.isSafeInteger(n) || n <= 0) throw new AssetsValidationError(`${label} 非法`)
    return n
  }
  throw new AssetsValidationError(`${label} 非法`)
}

export function assertStorageType(input: unknown): StorageType {
  if (input !== 'inline_text' && input !== 'file' && input !== 'external_link') {
    throw new AssetsValidationError('storageType 非法')
  }
  return input
}

/** 外链：非空 http(s)。 */
export function assertExternalUrl(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new AssetsValidationError('外链资产必须提供 externalUrl')
  }
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new AssetsValidationError('externalUrl 不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AssetsValidationError('externalUrl 仅允许 http(s)')
  }
  return url.toString()
}

/**
 * source JSON：必须是**对象**（非数组 / 非原始值），序列化后 ≤64 KiB。
 * 返回规范化的 JSON 字符串。
 */
export function assertSourceObject(input: unknown): string {
  if (input === undefined || input === null) return '{}'
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AssetsValidationError('source 必须是 JSON 对象')
  }
  const json = JSON.stringify(input)
  if (Buffer.byteLength(json, 'utf8') > ASSET_SOURCE_JSON_MAX_BYTES) {
    throw new AssetsValidationError('source 超过 64 KiB 上限')
  }
  return json
}

/**
 * 变量配置：与来源 `shared/src/template-config.ts` 的 `templateConfigError` 实现**同一套限制**。
 *
 * 限制清单（逐条对齐来源）：
 * - 顶层键仅 `version | variables`；`version === 1`；`variables` 为对象（非数组）。
 * - 变量数 ≤ 100。
 * - 变量名：非空、`name === name.trim()`、≤ 64 字、不含 `[{}:]`、
 *   非 `__proto__ / constructor / prototype`。
 * - 变量对象键仅 `type | options | separator`；`type` ∈ text/textarea/single/multi（**必填**）。
 * - `options`：数组、≤ 100 项、每项为非空 string 且 ≤ 500 字、**无重复**。
 * - `type` 为 `single | multi` 时 `options` **必须非空**。
 * - `separator`：string 且 ≤ 100 字。
 * - 整个配置 JSON ≤ 64000 字符。
 */
export function assertTemplateConfig(input: unknown): TemplateConfig {
  const empty: TemplateConfig = { version: 1, variables: {} }
  if (input === undefined || input === null) return empty
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AssetsValidationError('模板配置必须为对象')
  }
  const cfg = input as Record<string, unknown>
  // 顶层键仅 version | variables；version 必须为 1；variables 必须为对象。
  if (
    cfg.version !== 1 ||
    !cfg.variables ||
    typeof cfg.variables !== 'object' ||
    Array.isArray(cfg.variables) ||
    Object.keys(cfg).some((k) => !['version', 'variables'].includes(k))
  ) {
    throw new AssetsValidationError('模板配置版本或变量映射无效')
  }
  const entries = Object.entries(cfg.variables as Record<string, unknown>)
  if (entries.length > 100) throw new AssetsValidationError('模板变量配置最多 100 项')

  const variables: TemplateConfig['variables'] = {}
  for (const [name, raw] of entries) {
    if (
      name.trim() === '' ||
      name !== name.trim() ||
      name.length > 64 ||
      /[{}:]/.test(name) ||
      ['__proto__', 'constructor', 'prototype'].includes(name)
    ) {
      throw new AssetsValidationError('变量配置名称无效')
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AssetsValidationError('变量配置必须为对象')
    }
    const v = raw as Record<string, unknown>
    // type 必填且受限；变量对象只允许 type / options / separator 三个键。
    if (
      !['text', 'textarea', 'single', 'multi'].includes(String(v.type)) ||
      Object.keys(v).some((k) => !['type', 'options', 'separator'].includes(k))
    ) {
      throw new AssetsValidationError('变量输入类型无效')
    }
    if (v.options !== undefined) {
      if (
        !Array.isArray(v.options) ||
        v.options.length > 100 ||
        v.options.some((o) => typeof o !== 'string' || o.length === 0 || o.length > 500) ||
        new Set(v.options).size !== v.options.length
      ) {
        throw new AssetsValidationError('候选值需为不重复的非空文本，最多 100 项')
      }
    }
    if (['single', 'multi'].includes(String(v.type)) && (!Array.isArray(v.options) || v.options.length === 0)) {
      throw new AssetsValidationError('选择型变量需要候选值')
    }
    if (v.separator !== undefined && (typeof v.separator !== 'string' || v.separator.length > 100)) {
      throw new AssetsValidationError('连接符需为最多 100 字的文本')
    }
    variables[name] = {
      type: v.type as VariableInputType,
      ...(v.options !== undefined ? { options: v.options as string[] } : {}),
      ...(v.separator !== undefined ? { separator: v.separator as string } : {})
    }
  }
  // 整个配置 JSON ≤ 64000 字符（对来源原始输入取长度，与来源一致）。
  if (JSON.stringify(input).length > 64000) throw new AssetsValidationError('模板配置过大')
  return { version: 1, variables }
}
