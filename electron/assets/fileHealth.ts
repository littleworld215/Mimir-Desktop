import { constants, type Stats, promises as fileIO } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { FILE_HEALTH_BATCH_SIZE, type FileHealthBatch, type FileHealthCursor, type FileHealthItem, type FileHealthStatus } from '../../shared/assetsFileHealthContracts'
import { AssetsStoreError, type AssetsContext } from './types'
import { resolveWithinFiles } from './paths'

type FileIO = Pick<typeof fileIO, 'lstat' | 'open'>
const FILE_HEALTH_CONCURRENCY = 4
interface Row { assetId: number; assetName: string; assetCode: string; archived: string | null; versionId: number | null; version: number | null; filePath: string | null }
function bad(): never { throw new AssetsStoreError('BAD_REQUEST', '文件健康检查参数非法。') }
function cursor(input: unknown): FileHealthCursor | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'cursor')) bad()
  const value = (input as { cursor?: unknown }).cursor
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad()
  const keys = ['assetId', 'versionId', 'upperAssetId', 'upperVersionId'] as const
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k as typeof keys[number]))) bad()
  const row = value as FileHealthCursor
  for (const key of keys) if (!Number.isSafeInteger(row[key]) || row[key] < 0) bad()
  if (row.assetId < 1 || row.assetId > row.upperAssetId || row.versionId > row.upperVersionId) bad()
  return row
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const stableFile = (a: Stats, b: Stats) => same(a, b) && b.isFile() && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
function ancestors(file: string): string[] {
  const result = [file]
  for (let parent = dirname(file); parent !== result[result.length - 1]; parent = dirname(parent)) result.push(parent)
  return result.reverse()
}
async function inspect(ctx: AssetsContext, row: Row, io: FileIO): Promise<FileHealthStatus> {
  if (row.filePath === null) return 'no_file'
  const parts = row.filePath.replace(/\\/g, '/').split('/')
  if (parts.length < 3 || parts[0] !== 'files' || parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\u0000-\u001f\u007f]/.test(p) || /[. ]$/.test(p) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) return 'invalid_path'
  if (parts[1] !== String(row.assetId)) return 'wrong_owner'
  const target = join(ctx.layout.root, ...parts), chain = ancestors(resolve(target))
  try {
    const before: Stats[] = []
    for (const [index, path] of chain.entries()) {
      ctx.assertCurrent()
      const stat = await io.lstat(path); ctx.assertCurrent()
      if (stat.isSymbolicLink()) return 'invalid_path'
      if (index < chain.length - 1 && !stat.isDirectory()) return 'invalid_path'
      if (index === chain.length - 1 && !stat.isFile()) return 'not_file'
      before.push(stat)
    }
    try { resolveWithinFiles(ctx.layout, row.filePath) } catch { return 'invalid_path' }
    ctx.assertCurrent()
    const handle = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      ctx.assertCurrent()
      const actual = await handle.stat(); ctx.assertCurrent()
      if (!stableFile(before[before.length - 1], actual)) return 'changed'
      for (const [index, path] of chain.entries()) {
        const stat = await io.lstat(path); ctx.assertCurrent()
        if (stat.isSymbolicLink() || !same(before[index], stat) || (index < chain.length - 1 && !stat.isDirectory())) return 'changed'
        if (index === chain.length - 1 && !stableFile(actual, stat)) return 'changed'
      }
      try { resolveWithinFiles(ctx.layout, row.filePath) } catch { return 'changed' }
      return 'openable'
    } finally {
      try { await handle.close() } catch { throw new AssetsStoreError('FILE_UNAVAILABLE', '文件检查关闭失败，已停止本次检查。') }
    }
  } catch (error) {
    if (error instanceof AssetsStoreError) throw error
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable'
  }
}

/** SELECT-only synchronous metadata snapshot, then bounded async opens tracked by manager.run. No content reads or persistent report. */
export async function inspectFileHealthBatch(ctx: AssetsContext, request: unknown, io: FileIO = fileIO): Promise<FileHealthBatch> {
  const after = cursor(request)
  ctx.assertCurrent()
  const { bound, rows } = ctx.write(s => {
    const bound = after ?? { assetId: 0, versionId: 0, upperAssetId: s.get<{ n: number }>('SELECT COALESCE(MAX(id),0) n FROM asset')!.n, upperVersionId: s.get<{ n: number }>('SELECT COALESCE(MAX(id),0) n FROM asset_version')!.n }
    const rows = s.all<Row>(`SELECT a.id assetId,a.name assetName,a.code assetCode,a.archived_at archived,v.id versionId,v.version version,v.file_path filePath
      FROM asset a LEFT JOIN asset_version v ON v.asset_id=a.id AND v.id<=?
      WHERE a.storage_type='file' AND a.id<=? AND (a.id>? OR (a.id=? AND COALESCE(v.id,0)>?))
      ORDER BY a.id,COALESCE(v.id,0) LIMIT ?`, bound.upperVersionId, bound.upperAssetId, bound.assetId, bound.assetId, bound.versionId, FILE_HEALTH_BATCH_SIZE + 1)
    return { bound, rows }
  })
  const batchRows = rows.slice(0, FILE_HEALTH_BATCH_SIZE)
  const items: FileHealthItem[] = new Array(batchRows.length)
  let next = 0, failed = false, failure: unknown
  async function worker(): Promise<void> {
    while (!failed && next < batchRows.length) {
      const index = next++, row = batchRows[index]
      try {
        ctx.assertCurrent()
        const status = await inspect(ctx, row, io)
        ctx.assertCurrent()
        items[index] = { assetId: row.assetId, assetName: row.assetName, assetCode: row.assetCode, archived: Boolean(row.archived), versionId: row.versionId, version: row.version, status }
      } catch (error) {
        // A sibling may fail to close after space cancellation was observed.
        // Preserve that cleanup failure rather than downgrade it to cancellation.
        if (!failed || (failure instanceof AssetsStoreError && failure.code === 'SPACE_CHANGED' &&
            error instanceof AssetsStoreError && error.code === 'FILE_UNAVAILABLE')) failure = error
        failed = true
      }
    }
  }
  // Keep every per-file guard. A failed worker stops new work; all started checks
  // must finish their finally/close before manager.run can release this batch.
  await Promise.all(Array.from({ length: Math.min(FILE_HEALTH_CONCURRENCY, batchRows.length) }, worker))
  if (failed) throw failure
  ctx.assertCurrent()
  const last = items[items.length - 1]
  return { checkedAt: new Date().toISOString(), digestBaseline: 'not-established', items, nextCursor: rows.length > FILE_HEALTH_BATCH_SIZE ? { ...bound, assetId: last.assetId, versionId: last.versionId ?? 0 } : null }
}
