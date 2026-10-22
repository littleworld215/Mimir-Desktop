import { afterEach, expect, it } from 'vitest'
import * as library from '../../electron/library/libraryService'
import { getStoreValue, setStoreValue } from '../../electron/library/store'
import { captureWorkspaceOperation, createTestWorkspace, switchWorkspaceTo } from '../../electron/library/store'
import { createEditingService } from '../../electron/libraryEditing/service'
import { createEditingRepository } from '../../electron/libraryEditing/repository'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })))

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
it('orphan recovery input survives trash, restore and missing paper, never implicitly revives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trash-editing-')); roots.push(root)
  switchWorkspaceTo(createTestWorkspace('synthetic', root).id); seed()
  const service = createEditingService({ repository: createEditingRepository(), host: { readPaper: id => getStoreValue<Record<string, typeof paper>>('library:papers')?.[id], updatePaper: library.updatePaper } }), ctx = { scope: captureWorkspaceOperation(), assertCurrent() {} }
  const sessionId = service.open(ctx, 7, paper.arxivId, 'notes').sessionId!, d = service.save(ctx, 7, { sessionId, expectedRevision: 0, sequence: 1, input: '\n orphan \n' }), path = join(root, '.mimir/library-editing/drafts.json'), before = readFileSync(path)
  await library.removePaper(paper.arxivId)
  expect(service.detail(ctx, d.id)).toMatchObject({ status: 'trashed', draft: { input: '\n orphan \n' } })
  await expect(service.commit(ctx, 7, [{ sessionId, expectedRevision: d.revision, sequence: 2, input: 'wrong' }])).rejects.toThrow()
  library.restorePaper(paper.arxivId); expect(service.detail(ctx, d.id).status).toBe('editable')
  setStoreValue('library:papers', {}); expect(service.detail(ctx, d.id).status).toBe('missing')
  expect(service.open(ctx, 7, paper.arxivId, 'notes').sessionId).toBeUndefined(); expect(readFileSync(path)).toEqual(before)
})
