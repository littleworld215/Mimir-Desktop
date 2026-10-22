import { expect, it } from 'vitest'
import { importPaper, listPapers } from '../../electron/library/libraryService'
import { parseArxivFeed } from '../../electron/library/arxiv'
import { getStoreValue, setStoreValue } from '../../electron/library/store'
import { entryFromPaper } from '../../electron/library/bibtex'

const entry = { id: '2601.00001v2', title: 'Synthetic dates', authors: [], summary: '', published: '2026-01-02T10:00:00Z', url: '', source: 'arxiv' as const }

it('保留初始提交和版本更新的原值与来源，不冒充来源出版日期', async () => {
  const [parsed] = parseArxivFeed('<feed><entry><id>https://arxiv.org/abs/2601.00001v2</id><title>Synthetic</title><published>2026-01-02T10:00:00Z</published><updated>2026-02-03T18:00:00Z</updated></entry></feed>')
  await importPaper(parsed!)
  expect(listPapers()[0]).toMatchObject({ dates: {
    arxivSubmitted: { value: entry.published, precision: 'instant', source: 'arxiv' },
    arxivUpdated: { value: '2026-02-03T18:00:00Z', precision: 'instant', source: 'arxiv' }
  } })
  expect((listPapers()[0] as any).dates.sourcePublished).toBeUndefined()
})

it('仅年份保留年份精度；重新导入空值或粗日期不擦除更精确日期及用户内容', async () => {
  await importPaper({ ...entry, source: 'openalex', published: '2025-06-27' })
  const original = listPapers()[0]!
  setStoreValue('library:papers', { [entry.id]: { ...original, notes: '保留\n\n多段', tags: ['keep'], pdfPath: 'synthetic.pdf' } })
  await importPaper({ ...entry, source: 'openalex', published: '2025' })
  await importPaper({ ...entry, source: 'openalex', published: '' })
  expect(listPapers()[0]).toMatchObject({ addedAt: original.addedAt, notes: '保留\n\n多段', tags: ['keep'], pdfPath: 'synthetic.pdf',
    dates: { sourcePublished: { value: '2025-06-27', precision: 'day', source: 'openalex' } } })
  await importPaper({ ...entry, id: 'year', source: 'semantic-scholar', published: '2024' })
  expect(listPapers().find(p => p.arxivId === 'year')).toMatchObject({ dates: { sourcePublished: { value: '2024', precision: 'year', source: 'semantic-scholar' } } })
})

it('旧记录不猜填；未知来源不因arXiv形状ID就推断提交时间', async () => {
  const legacy = { arxivId: entry.id, title: 'Old', authors: [], summary: '', url: '', notes: '', tags: [], projectIds: [], addedAt: '2020-01-01' }
  setStoreValue('library:papers', { [entry.id]: legacy })
  expect(listPapers()).toEqual([legacy])
  expect(getStoreValue('library:papers')).toEqual({ [entry.id]: legacy })
  await importPaper({ ...entry, source: undefined })
  expect(listPapers()[0]).toMatchObject({ dates: { sourcePublished: { value: entry.published, source: 'unknown' } } })
  expect((listPapers()[0] as any).dates.arxivSubmitted).toBeUndefined()
})

it.each(['2025-02-30', '2026-13-01', 'n/a', '2026-01-01junk'])('不把非法日期 %s 保存成有效日期', async published => {
  await importPaper({ ...entry, published })
  expect((listPapers()[0] as any).dates).toBeUndefined()
})

it('BibTeX不以入库年份冒充论文年份，有来源年份才导出', async () => {
  await importPaper({ ...entry, published: '' })
  expect(entryFromPaper(listPapers()[0]!).fields.year).toBeUndefined()
  await importPaper({ ...entry, published: '2024' })
  expect(entryFromPaper(listPapers()[0]!).fields.year).toBe('2024')
})
