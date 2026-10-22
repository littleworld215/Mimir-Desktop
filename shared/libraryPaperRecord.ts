import type { PaperDates } from './libraryDates'

/** 单篇论文的 AI 相关性评分（按项目） */
export interface PaperRelevance {
  score: number
  reason: string
  at: string
}

/** 文献库中的论文记录 */
export interface PaperRecord {
  /** 可恢复移除；不删除原记录、PDF或关联历史。 */
  removedAt?: string
  dates?: PaperDates
  /** 裸 arXiv id（可带版本后缀，如 2103.00020v2）；非 arXiv 出版物为 `doi:xxx` */
  arxivId: string
  title: string
  authors: string[]
  summary: string
  url: string
  /** 来源标识（openalex / semantic-scholar / arxiv），展示与排障用 */
  source?: 'openalex' | 'semantic-scholar' | 'arxiv'
  /**
   * 开放获取 PDF 直链（入库时从检索源带回）。arXiv 条目走 arXiv 通道下载，
   * 该字段主要服务非 arXiv 的期刊/会议论文——没有它就只能去网页端手动找。
   */
  pdfUrl?: string
  /** pdfUrl 的来源（如 'openalex-oa' / 'unpaywall'），用于展示与排障 */
  pdfSource?: string
  /** 自由格式的工作笔记（阅读笔记以 [YYYY-MM-DD HH:mm] 块追加） */
  notes: string
  /** 组织标签 */
  tags: string[]
  /** 关联的项目 id 列表 */
  projectIds: string[]
  /** 已下载 PDF 的绝对路径；未下载时缺省 */
  pdfPath?: string
  /** AI 相关性评分，按项目 id 索引 */
  relevance?: Record<string, PaperRelevance>
  /** 首次写入时间（ISO-8601） */
  addedAt: string
}

