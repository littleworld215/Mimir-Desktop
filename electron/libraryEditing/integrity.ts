import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { isAbsolute, join } from 'node:path'
import type { PaperRecord } from '../../shared/libraryPaperRecord'
import { assertPaperMetadata } from '../library/integrity'
import { RestoreError } from '../workspaceBackup/restoreContracts'
import { createEditingRepository } from './repository'
import { EditingError } from './validation'
const stat = (path: string) => { try { return lstatSync(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e } }
/** Fixed, read-only catalogue; no global store/cache initialization, migrations or writes. */
export function readEditingPaperCatalog(root: string): Record<string, PaperRecord> {
  const base = stat(root), folder = stat(join(root, '.mimir'))
  if (!isAbsolute(root) || !base?.isDirectory() || base.isSymbolicLink() || (folder && (!folder.isDirectory() || folder.isSymbolicLink()))) throw new EditingError('SOURCE_UNAUTHORIZED')
  if (!folder) return {}
  const path = join(root, '.mimir/store.json'), entry = stat(path)
  if (!entry) return {}
  const limit = 64 * 1024 * 1024
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit) throw new EditingError('CORRUPT_DATA')
  let fd: number | undefined
  try {
    fd = openSync(path, 'r'); const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > limit) throw Error('changed')
    const buffer = Buffer.alloc(opened.size + 1); let length = 0
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n }
    const after = fstatSync(fd), current = stat(path), parent = stat(join(root, '.mimir'))
    if (length !== opened.size || !parent || parent.isSymbolicLink() || parent.ino !== folder.ino || parent.dev !== folder.dev || !current || current.isSymbolicLink() || [after, current].some(v => v.ino !== opened.ino || v.dev !== opened.dev || v.size !== opened.size || v.mtimeMs !== opened.mtimeMs || v.ctimeMs !== opened.ctimeMs) || !isUtf8(buffer.subarray(0, length))) throw Error('changed')
    const store = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw Error('store')
    const papers = store['library:papers'] ?? {}
    if (!papers || typeof papers !== 'object' || Array.isArray(papers)) throw Error('papers')
    for (const [id, p] of Object.entries(papers)) {
      if (!p || typeof p !== 'object' || Array.isArray(p) || !('arxivId' in p) || p.arxivId !== id || !('notes' in p) || typeof p.notes !== 'string' || !('tags' in p) || !Array.isArray(p.tags) || p.tags.some(t => typeof t !== 'string')) throw Error('paper')
      assertPaperMetadata(p)
    }
    return papers as Record<string, PaperRecord>
  } catch (e) { if (e instanceof EditingError) throw e; throw new EditingError('CORRUPT_DATA', '文献关联无法读取，原资料保留') }
  finally { if (fd !== undefined) closeSync(fd) }
}
export function inspectEditingIntegrity(root: string): { state: 'unused' | 'valid' | 'warning' | 'invalid' | 'unsupported'; draftCount: number; unresolvedCount: number; code?: string } {
  let draftCount = 0
  try {
    const doc = createEditingRepository().read(root)
    if (!stat(join(root, '.mimir/library-editing/drafts.json'))) return { state: 'unused', draftCount, unresolvedCount: 0 }
    draftCount = doc.drafts.length
    const papers = draftCount ? readEditingPaperCatalog(root) : {}, unresolvedCount = doc.drafts.filter(d => !papers[d.paperId] || papers[d.paperId].removedAt !== undefined).length
    return { state: unresolvedCount ? 'warning' : 'valid', draftCount, unresolvedCount }
  } catch (e) {
    const code = e instanceof EditingError ? e.code : 'CORRUPT_DATA'
    return { state: code === 'UNSUPPORTED_VERSION' ? 'unsupported' : 'invalid', draftCount, unresolvedCount: 0, code }
  }
}
export function assertRestoredEditingIntegrity(root: string): void {
  const r = inspectEditingIntegrity(root)
  if (r.state === 'invalid' || r.state === 'unsupported') throw new RestoreError('RECHECK_FAILED', `恢复草稿无法校验（${r.code}），原备份保留，请使用兼容版本检查`)
}
