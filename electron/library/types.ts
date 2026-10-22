/**
 * 文献库领域类型定义（对齐 Mimir 的 PaperRecord / ProjectRecord 模型）
 */



/** 一篇 arXiv 论文条目（搜索结果 / 订阅新论文共用） */
export interface ArxivEntry {
  /** 主键：裸 arXiv id（如 1512.03385）；非 arXiv 出版物为 `doi:xxx` */
  id: string
  title: string
  authors: string[]
  summary: string
  published: string
  /** arXiv Atom updated，不能与 published 或正式出版混为一谈。 */
  updated?: string
  url: string
  /** 来源标识（统一访问层填充：openalex / semantic-scholar / arxiv），展示与排障用 */
  source?: 'openalex' | 'semantic-scholar' | 'arxiv'
  /** 开放获取 PDF 直链（统一访问层从 OpenAlex 等投影而来）；缺省表示未发现 OA 版本 */
  pdfUrl?: string
  /** pdfUrl 的来源，展示与排障用（如 'openalex-oa'） */
  pdfSource?: string
}

/** 一条网页搜索结果 */
export interface WebSearchEntry {
  title: string
  url: string
  content: string
  engine: string
  category: string
  publishedDate: string
}

export type { PaperRecord, PaperRelevance } from '../../shared/libraryPaperRecord'

/** 研究项目 */
export interface ProjectRecord {
  id: string
  title: string
  /** 项目对应的本地 LaTeX 目录（可选，用于 BibTeX 导出） */
  paperDir?: string
  /** 创建时间（ISO-8601） */
  createdAt: string
  /** 最后更新时间（ISO-8601） */
  updatedAt: string
}

/** arXiv 订阅记录 */
export interface ArxivSubscriptionRecord {
  id: string
  query: string
  createdAt: string
  lastCheckedAt: string | null
  /** 已见过的论文 id（用于判断新论文） */
  seenIds: string[]
  /** 新论文 id 列表 */
  newEntryIds: string[]
  /** 新论文详情 */
  newEntries: ArxivEntry[]
}

/** 订阅的对外视图（seenIds 是内部记账，不暴露） */
export interface ArxivSubscriptionView {
  id: string
  query: string
  createdAt: string
  lastCheckedAt: string | null
  newEntries: ArxivEntry[]
}

/** 一次订阅检查的结果 */
export interface SubscriptionCheckOutcome {
  subscription: ArxivSubscriptionView
  added: string[]
  error: string | null
}

/** BibTeX 条目 */
export interface BibEntry {
  key: string
  type: string
  fields: Record<string, string>
}
