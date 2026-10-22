import { expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchPaperPdf, listPapers, removePaper } from '../../electron/library/libraryService'
import { fetchArxivPdf } from '../../electron/library/arxiv'
import { getStoreValue, setStoreValue, spaceRoot } from '../../electron/library/store'
import * as store from '../../electron/library/store'
vi.mock('../../electron/library/arxiv', async original => ({ ...await original<typeof import('../../electron/library/arxiv')>(), fetchArxivPdf: vi.fn() }))
it('真实文件下载等待及写盘期间拒绝回收，任务结束后回收不再改PDF', async () => {
  const id = '2601.12345', path = join(spaceRoot(), 'papers', id + '.pdf')
  mkdirSync(join(spaceRoot(), 'papers'), { recursive: true }); writeFileSync(path, '%PDF-1.7\nold')
  const paper = { arxivId: id, title: 'synthetic', authors: [], summary: '', url: '', notes: 'keep', tags: [], projectIds: [], addedAt: '2026-01-01', pdfPath: path }
  setStoreValue('library:papers', { [id]: paper })
  let finish!: (bytes: Uint8Array) => void
  vi.mocked(fetchArxivPdf).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const download = fetchPaperPdf(id)
  try {
    await vi.waitFor(() => expect(fetchArxivPdf).toHaveBeenCalled())
    await expect(removePaper(id)).rejects.toThrow(/PDF.*处理中/)
    expect(readFileSync(path, 'utf8')).toBe('%PDF-1.7\nold')
    expect(listPapers()).toEqual([paper])
  } finally { finish(Buffer.from('%PDF-1.7\nnew')); await download.catch(() => {}) }
  expect(await download).toMatchObject({ pdfPath: path, pdfSource: 'arxiv' })
  expect(readFileSync(path, 'utf8')).toBe('%PDF-1.7\nnew')
  const saved = readFileSync(path)
  await removePaper(id)
  expect(readFileSync(path)).toEqual(saved)
  expect(getStoreValue<Record<string, any>>('library:papers')![id].removedAt).toBeTypeOf('string')
})
it('PDF元数据持久化失败不把未保存字段留在内存', async () => {
  const id = '2601.12346'
  const paper = { arxivId: id, title: 'synthetic failure', authors: [], summary: '', url: '', notes: 'keep', tags: [], projectIds: [], addedAt: '2026-01-01' }
  setStoreValue('library:papers', { [id]: paper })
  vi.mocked(fetchArxivPdf).mockResolvedValueOnce(Buffer.from('%PDF-1.7\nnew'))
  const spy = vi.spyOn(store, 'setStoreValue').mockImplementationOnce(() => { throw Error('合成元数据保存失败') })
  try {
    await expect(fetchPaperPdf(id)).rejects.toThrow('合成元数据保存失败')
    expect(listPapers()).toEqual([paper])
  } finally { spy.mockRestore() }
})
