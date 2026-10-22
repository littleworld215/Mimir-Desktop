/** 前端文献库类型（与 electron/library/types.ts 对齐） */
import type { PaperDates } from '../../../../shared/libraryDates'

export interface ArxivEntry {
  id: string
  title: string
  authors: string[]
  summary: string
  published: string
  updated?: string
  url: string
  source?: 'openalex' | 'semantic-scholar' | 'arxiv'
}

export interface WebSearchEntry {
  title: string
  url: string
  content: string
  engine: string
  category: string
  publishedDate: string
}

export interface PaperRelevance {
  score: number
  reason: string
  at: string
}

export interface PaperRecord {
  dates?: PaperDates
  arxivId: string
  title: string
  authors: string[]
  summary: string
  url: string
  notes: string
  tags: string[]
  projectIds: string[]
  pdfPath?: string
  relevance?: Record<string, PaperRelevance>
  addedAt: string
}

export interface ProjectRecord {
  id: string
  title: string
  paperDir?: string
  createdAt: string
  updatedAt: string
}

export interface ArxivSubscriptionView {
  id: string
  query: string
  createdAt: string
  lastCheckedAt: string | null
  newEntries: ArxivEntry[]
}

export interface SubscriptionCheckOutcome {
  subscription: ArxivSubscriptionView
  added: string[]
  error: string | null
}

export interface ZoteroCollection {
  key: string
  name: string
  numItems: number
}

export interface ZoteroItem {
  key: string
  title: string
  creators: string[]
  date: string
  url: string
}

/** 搜索结果统一视图（arXiv 或 Web） */
export type SearchResult = ArxivEntry | WebSearchEntry

/** 明确区分业务保存失败与已保存，编辑器不能把正常返回当作成功。 */
export interface PaperSaveResult { ok: boolean; message?: string }

export function isArxivEntry(entry: SearchResult): entry is ArxivEntry {
  return 'id' in entry && 'published' in entry
}

/** 生成 PDF 阅读 URL（mimir-pdf:// 自定义协议） */
export function pdfUrlOf(arxivId: string): string {
  return `mimir-pdf://paper/${encodeURIComponent(arxivId)}.pdf`
}

/** 只派生显示数据，保留自由笔记前缀及每条记录内部的全部空行。 */
export function readingNotesView(notes: string): { plain: string; entries: { at: string; text: string }[] } {
  const headers = [...notes.matchAll(/(?:^|\n{2,})\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n/g)]
  if (!headers.length) return { plain: notes, entries: [] }
  return {
    plain: notes.slice(0, headers[0]!.index),
    entries: headers.map((header, index) => ({
      at: header[1]!,
      text: notes.slice(header.index! + header[0].length, headers[index + 1]?.index ?? notes.length)
    }))
  }
}

/** 保留原有调用契约；每条记录现在包含完整多段正文。 */
export function parseReadingNotes(notes: string): { at: string; text: string }[] { return readingNotesView(notes).entries }

/** 追加一条带时间戳的阅读笔记 */
export function appendReadingNote(notes: string, text: string, now: Date): string {
  const body = text.trim()
  if (body === '') return notes
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const entry = `[${stamp}]\n${body}`
  return notes.trimEnd() === '' ? entry : `${notes.trimEnd()}\n\n${entry}`
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '未知'
  if (/^[1-9]\d{3}$/.test(dateStr)) return dateStr + '年（仅年份）'
  try {
    const d = new Date(dateStr)
    if (!Number.isFinite(d.getTime())) return '未知'
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short' })
  } catch {
    return dateStr
  }
}
