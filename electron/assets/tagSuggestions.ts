/**
 * AI 标签建议的**服务端纯逻辑**（解析 / 归一化 / 上限控制）。
 *
 * 设计取舍：标签建议**不进 `ai_draft`**（那是给正文草稿用的，采纳语义是「生成新版本」），
 * 因此本功能**零数据库迁移**。标签采纳走现有的 `POST /assets/:id/tags` 幂等接口。
 *
 * ⚠️ **零相对导入**，以便被 content-check 通过 data URL 加载。
 */
/** 本模块内的结构兼容类型（避免 data URL 测试环境解析相对导入）。 */
interface TagSuggestion {
  name: string
  existingTagId: number | null
  reason?: string
  displayName?: string
}

/** 默认返回上限 */
export const TAG_SUGGEST_MAX = 6
/** 硬上限（即使模型返回更多也截断到这里） */
export const TAG_SUGGEST_HARD_MAX = 8
/** 正文送模型的字符上限（控制成本） */
export const TAG_SUGGEST_CONTENT_CHARS = 4000
/** 单个标签名长度上限 */
export const TAG_NAME_MAX_LEN = 20

/**
 * 标签名归一化：去首尾空白 + 折叠内部空白 + 转小写。
 * 用于「同名忽略大小写复用已有标签」的比对，**不用于存储**（存储保留用户原本的写法）。
 */
export function normalizeTagName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** 在已有标签中查找归一化同名的项，返回其 id；未命中返回 null */
export function matchExistingTag(name: string, tags: Array<{ id: number; name: string }>): number | null {
  const key = normalizeTagName(name)
  if (!key) return null
  for (const t of tags) {
    if (normalizeTagName(t.name) === key) return t.id
  }
  return null
}

/** 正文截断（控成本）；返回是否发生截断 */
export function truncateForSuggest(
  content: string,
  maxChars: number = TAG_SUGGEST_CONTENT_CHARS
): { text: string; truncated: boolean } {
  const s = String(content ?? '')
  if (s.length <= maxChars) return { text: s, truncated: false }
  return { text: s.slice(0, maxChars), truncated: true }
}

/** 构造送模型的提示词。要求「只输出标签名、每行一个、不要解释」，便于三级降级解析。 */
export function buildTagSuggestPrompt(
  content: string,
  existingNames: string[],
  max: number,
  instruction?: string
): string {
  const limit = Math.min(Math.max(1, Math.floor(max) || TAG_SUGGEST_MAX), TAG_SUGGEST_HARD_MAX)
  // 首行指令：可注入（如中文专属提示词），缺省回退到内置说明；保持零相对导入
  const instructionLine =
    instruction ?? '你是科研资产库的标签助手。请阅读下面的资产正文，给出最合适的标签。'
  const existing = existingNames.length
    ? `\n库内已有标签（优先复用，若语义相符请直接使用原词）：${existingNames.join('、')}`
    : ''
  return [
    instructionLine,
    `要求：最多 ${limit} 个；每个标签 2-${TAG_NAME_MAX_LEN} 个字；只输出标签名，每行一个；不要编号、不要解释、不要标点。`,
    existing,
    '',
    '正文：',
    content,
  ].join('\n')
}

/** 去掉行首编号 / 项目符号 / 包裹引号 */
function cleanLine(line: string): string {
  let s = line.trim()
  s = s.replace(/^[-*·•]\s*/, '')
  s = s.replace(/^\d+[.、)]\s*/, '')
  s = s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
  return s.trim()
}

/** 标签名是否可用：非空、不超长、不含换行/分隔符 */
function isUsableName(name: string): boolean {
  if (!name) return false
  if (name.length > TAG_NAME_MAX_LEN) return false
  if (/[\n\r,，、;；|]/.test(name)) return false
  return true
}

/**
 * 解析模型返回的标签建议，**三级降级**：
 *  1. `json` —— 返回体是 JSON 数组（或含 `tags` 字段的对象）
 *  2. `lines` —— 按行切分（模型最常见的输出形态）
 *  3. `empty` —— 都拿不到可用标签
 *
 * 解析后统一：去重（按归一化名）、命中已有标签则填 `existingTagId`、按上限截断。
 */
export function parseTagSuggestions(
  raw: string,
  existing: Array<{ id: number; name: string }>,
  max: number = TAG_SUGGEST_MAX
): { items: TagSuggestion[]; truncated: boolean; mode: 'json' | 'lines' | 'empty' } {
  const limit = Math.min(Math.max(1, Math.floor(max) || TAG_SUGGEST_MAX), TAG_SUGGEST_HARD_MAX)
  const candidates: string[] = []
  let mode: 'json' | 'lines' | 'empty' = 'empty'

  // —— 一级：JSON ——
  const text = String(raw ?? '').trim()
  if (text) {
    const jsonText = extractJson(text)
    if (jsonText !== null) {
      try {
        const parsed: unknown = JSON.parse(jsonText)
        const arr = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as { tags?: unknown }).tags)
            ? ((parsed as { tags: unknown[] }).tags)
            : null
        if (arr) {
          for (const item of arr) {
            if (typeof item === 'string') candidates.push(item)
            else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
              candidates.push((item as { name: string }).name)
            }
          }
          mode = 'json'
        }
      } catch {
        /* 落到二级 */
      }
    }
  }

  // —— 二级：按行 ——
  if (mode !== 'json') {
    const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean)
    if (lines.length) {
      candidates.push(...lines)
      mode = 'lines'
    }
  }

  // —— 统一清洗 + 去重 + 上限 ——
  const items: TagSuggestion[] = []
  const seen = new Set<string>()
  let hardTruncated = false
  for (const rawName of candidates) {
    const name = cleanLine(String(rawName))
    if (!isUsableName(name)) continue
    const key = normalizeTagName(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    items.push({ name, existingTagId: matchExistingTag(name, existing) })
    if (items.length > TAG_SUGGEST_HARD_MAX) {
      hardTruncated = true
      items.pop()
      break
    }
  }

  const truncated = hardTruncated || items.length > limit
  return { items: truncated && items.length > limit ? items.slice(0, limit) : items, truncated, mode: items.length ? mode : 'empty' }
}

/** 从可能夹带说明文字的输出里抽出第一段 JSON（数组或对象） */
function extractJson(text: string): string | null {
  const startArr = text.indexOf('[')
  const startObj = text.indexOf('{')
  let start = -1
  let open = ''
  let close = ''
  if (startArr >= 0 && (startObj < 0 || startArr < startObj)) {
    start = startArr
    open = '['
    close = ']'
  } else if (startObj >= 0) {
    start = startObj
    open = '{'
    close = '}'
  }
  if (start < 0) return null
  const end = text.lastIndexOf(close)
  if (end <= start) return null
  void open
  return text.slice(start, end + 1)
}

