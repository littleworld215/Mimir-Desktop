/** Source dates are optional: absence never means the ingestion timestamp. */
export type PaperDateSource = 'arxiv' | 'openalex' | 'semantic-scholar' | 'unknown'
export interface PaperDate {
  value: string
  precision: 'year' | 'day' | 'instant'
  source: PaperDateSource
}
export interface PaperDates {
  arxivSubmitted?: PaperDate
  arxivUpdated?: PaperDate
  sourcePublished?: PaperDate
}

export function sourceDate(raw: unknown, source: PaperDateSource): PaperDate | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (/^[1-9]\d{3}$/.test(value)) return { value, source, precision: 'year' }
  const day = /^([1-9]\d{3})-(\d{2})-(\d{2})(.*)$/.exec(value)
  if (!day) return undefined
  const date = value.slice(0, 10)
  const parsed = new Date(date + 'T00:00:00Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return undefined
  if (!day[4]) return { value, source, precision: 'day' }
  if (!/^T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(day[4]) || !Number.isFinite(Date.parse(value))) return undefined
  return { value, source, precision: 'instant' }
}

export function mergePaperDates(existing: PaperDates | undefined, entry: { published: string; updated?: string; source?: PaperDateSource }): PaperDates | undefined {
  const dates: PaperDates = { ...existing }
  const rank = { year: 0, day: 1, instant: 2 }
  function accept(key: keyof PaperDates, raw: unknown, source: PaperDateSource) {
    const incoming = sourceDate(raw, source)
    if (incoming && (!dates[key] || rank[incoming.precision] >= rank[dates[key]!.precision])) dates[key] = incoming
  }
  if (entry.source === 'arxiv') {
    accept('arxivSubmitted', entry.published, 'arxiv')
    accept('arxivUpdated', entry.updated, 'arxiv')
  } else accept('sourcePublished', entry.published, entry.source ?? 'unknown')
  return Object.keys(dates).length ? dates : undefined
}

export function paperDateLabels(dates?: PaperDates): Array<{ text: string; title: string }> {
  const fields = [['arxivSubmitted', 'arXiv初始提交'], ['arxivUpdated', 'arXiv版本更新'], ['sourcePublished', '来源出版']] as const
  return fields.flatMap(([key, label]) => {
    const date = dates?.[key]
    if (!date || !sourceDate(date.value, date.source)) return []
    return [{ text: label + '：' + (date.precision === 'year' ? date.value + '（仅年份）' : date.value.slice(0, 10)),
      title: '来源：' + date.source + '；原值：' + date.value }]
  })
}
