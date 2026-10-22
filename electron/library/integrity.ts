import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceDate } from '../../shared/libraryDates'
import { isPaperTrashed } from '../../shared/libraryLifecycle'
import { RestoreError } from '../workspaceBackup/restoreContracts'

/** Validate new optional metadata only; legacy dates are never inferred or rewritten. */
export function assertPaperMetadata(row: Record<string, unknown>): void {
  if ('removedAt' in row && sourceDate(row.removedAt, 'unknown')?.precision !== 'instant') throw Error('INVALID_TOMBSTONE')
  if (row.dates === undefined) return
  if (!row.dates || typeof row.dates !== 'object' || Array.isArray(row.dates)) throw Error('INVALID_DATES')
  for (const [key, value] of Object.entries(row.dates)) {
    if (!['arxivSubmitted', 'arxivUpdated', 'sourcePublished'].includes(key) || !value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_DATES')
    const date = value as Record<string, unknown>
    if (!['arxiv', 'openalex', 'semantic-scholar', 'unknown'].includes(String(date.source)) || (key !== 'sourcePublished' && date.source !== 'arxiv')) throw Error('INVALID_DATES')
    const parsed = sourceDate(date.value, date.source as 'unknown')
    if (!parsed || parsed.precision !== date.precision) throw Error('INVALID_DATES')
  }
}
export function inspectLibraryIntegrity(root: string): { state: 'unused' | 'valid' | 'invalid'; active: number; trashed: number } {
  let active = 0, trashed = 0
  try {
    const folder = join(root, '.mimir'), path = join(folder, 'store.json')
    if (existsSync(folder) && (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory())) throw Error('UNSAFE_PATH')
    if (!existsSync(path)) return { state: 'unused', active, trashed }
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error('UNSAFE_STORE')
    const store = JSON.parse(readFileSync(path, 'utf8'))
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw Error('INVALID_STORE')
    const papers = store['library:papers']
    if (papers === undefined) return { state: 'unused', active, trashed }
    if (!papers || typeof papers !== 'object' || Array.isArray(papers)) throw Error('INVALID_PAPERS')
    for (const value of Object.values(papers)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_PAPER')
      assertPaperMetadata(value as Record<string, unknown>)
      if (isPaperTrashed(value)) trashed++
      else active++
    }
    return { state: 'valid', active, trashed }
  } catch { return { state: 'invalid', active, trashed } }
}
export function assertRestoredLibraryIntegrity(root: string): void {
  if (inspectLibraryIntegrity(root).state === 'invalid') throw new RestoreError('RECHECK_FAILED', '文献日期或回收状态损坏/不兼容，原备份保留')
}
