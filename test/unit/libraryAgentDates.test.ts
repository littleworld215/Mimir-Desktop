import { afterEach, expect, it, vi } from 'vitest'
import { fetchArxivEntriesByIds } from '../../electron/agent/tools/arxivSearch'
import { importPaper, listPapers } from '../../electron/library/libraryService'
afterEach(() => vi.unstubAllGlobals())
it('Agent实际批量Atom读取与导入同样保留版本更新时间', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<feed><entry><id>https://arxiv.org/abs/2601.12345v2</id><title>Synthetic</title><published>2024-01-02T00:00:00Z</published><updated>2025-03-04T00:00:00Z</updated></entry></feed>')))
  const [entry] = await fetchArxivEntriesByIds(['2601.12345'])
  await importPaper(entry!)
  expect(listPapers()[0]).toMatchObject({ dates: {
    arxivSubmitted: { value: '2024-01-02T00:00:00Z', source: 'arxiv' },
    arxivUpdated: { value: '2025-03-04T00:00:00Z', source: 'arxiv' }
  } })
})
