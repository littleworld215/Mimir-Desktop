import { expect, it } from 'vitest'
import * as library from '../../electron/library/libraryService'
import { getStoreValue, setStoreValue } from '../../electron/library/store'

const paper = { arxivId: 'synthetic', title: 'Keep all', authors: ['A'], summary: '摘要', url: 'https://example.org', notes: '原笔记\n\n多段', tags: ['tag'], projectIds: ['missing-project'], pdfPath: 'synthetic.pdf', addedAt: '2024-01-02', dates: { sourcePublished: { value: '2023', precision: 'year' as const, source: 'openalex' as const } } }
function seed() { setStoreValue('library:papers', { [paper.arxivId]: structuredClone(paper) }) }

it('移除隐藏当前文献但保留原标识、正文、PDF路径、日期与关联', async () => {
  seed()
  await library.removePaper(paper.arxivId)
  expect(library.listPapers()).toEqual([])
  const stored = getStoreValue<Record<string, unknown>>('library:papers')!
  expect(stored[paper.arxivId]).toMatchObject({ ...paper, removedAt: expect.any(String) })
})

it('重新导入已回收文献必须明确拒绝，不能暗中恢复或覆写笔记', async () => {
  seed()
  await library.removePaper(paper.arxivId)
  const before = structuredClone(getStoreValue('library:papers'))
  await expect(library.importPaper({ id: paper.arxivId, title: 'Overwrite', authors: [], summary: '', url: '', published: '' })).rejects.toThrow(/回收站/)
  expect(getStoreValue('library:papers')).toEqual(before)
})

it('已回收文献不能通过旧编辑入口继续写入', async () => {
  seed()
  await library.removePaper(paper.arxivId)
  await expect(library.updatePaper({ arxivId: paper.arxivId, notes: '不应覆盖' })).rejects.toThrow(/回收站/)
})
