import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const fields = () => ({ paperId: 'doi:10.1000/example', projectIds: ['project-1'], question: '研究问题', claim: '待核对判断', quote: '  摘录😀\n\n', method: '', datasetOrMaterial: '', finding: '', limitation: '', comment: '', relation: 'unassessed' as const, locator: { pageStart: 1 } })
export const version = () => ({ ...fields(), version: 1, paperSnapshot: { id: fields().paperId, title: '文献', authors: ['作者'], url: 'https://example.org/paper' }, documentBinding: null, reviewState: 'draft' as const, archived: false, updatedAt: '2026-10-17T00:00:00.000Z' })
export const document = () => ({ schemaVersion: 1 as const, revision: 1, cards: [{ id: randomUUID(), createdAt: '2026-10-17T00:00:00.000Z', currentVersion: 1, versions: [version()] }] })
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-evidence-'))
  const catalog = {
    papers: () => [{ arxivId: fields().paperId, title: '文献', authors: ['作者'], summary: '', url: 'https://example.org/paper', notes: '旧笔记', tags: [], projectIds: ['project-1'], addedAt: '2026-10-17' }],
    projects: () => [{ id: 'project-1', title: '课题', createdAt: '2026-10-17', updatedAt: '2026-10-17' }]
  }
  const ctx = { scope: { id: 'space-1', epoch: 'epoch-1', root }, signal: new AbortController().signal, assertCurrent: () => {}, catalog }
  return { root, ctx, clean: () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mimir-evidence-')) throw Error('Refuse unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  } }
}
