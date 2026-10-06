import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AssetDeleteImpact } from '../../shared/assetsContracts'
import { detail, selectAsset } from './assetRepository'
import { resolveWithinFiles } from './paths'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new AssetsStoreError('BAD_REQUEST', '标识及版本必须为正整数。')
  return value
}
function asset(s: AssetsWriteSession, id: number, expected?: number) {
  const row = selectAsset(s, id)
  if (!row) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
  if (expected !== undefined && expected !== row.revision) throw new AssetsStoreError('REVISION_CONFLICT', '资产已改变，请重新加载。', { currentRevision: row.revision })
  return row
}
function setArchived(ctx: AssetsContext, assetId: unknown, expectedRevision: unknown, archived: boolean) {
  const id = positive(assetId), revision = positive(expectedRevision)
  return ctx.write(s => {
    const row = asset(s, id, revision)
    const changed = Boolean(row.archived_at) !== archived
    if (changed) {
      const now = new Date().toISOString()
      s.run('UPDATE asset SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=?', archived ? now : null, now, id)
    }
    return { asset: detail(s, asset(s, id), ctx.layout), changed }
  })
}
export function archiveAsset(ctx: AssetsContext, assetId: unknown, expectedRevision: unknown) { return setArchived(ctx, assetId, expectedRevision, true) }
export function restoreAsset(ctx: AssetsContext, assetId: unknown, expectedRevision: unknown) { return setArchived(ctx, assetId, expectedRevision, false) }

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
/** Refuse junctions even to another asset inside files; only flat owned blob paths are eligible. */
function ownedDirectory(ctx: AssetsContext, id: number): string {
  const directory = join(ctx.layout.filesDir, String(id))
  for (const path of [ctx.layout.filesDir, directory]) {
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('资产文件目录不是可信普通目录。')
    } catch (error) { if (!missing(error)) throw error }
  }
  return directory
}
function ownedFile(ctx: AssetsContext, id: number, path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  if (segments.length !== 3 || segments[0] !== 'files' || segments[1] !== String(id)) throw new Error('文件不属于待删除资产。')
  ownedDirectory(ctx, id)
  const absolute = resolveWithinFiles(ctx.layout, path)
  try { if (!lstatSync(absolute).isFile()) throw new Error('资产blob不是普通文件。') }
  catch (error) { if (!missing(error)) throw error }
  return absolute
}
function blobPaths(s: AssetsWriteSession, id: number): string[] {
  return s.all<{ file_path: string }>('SELECT DISTINCT file_path FROM asset_version WHERE asset_id=? AND file_path IS NOT NULL', id).map(row => row.file_path)
}
export function deletePreview(ctx: AssetsContext, assetId: unknown): AssetDeleteImpact {
  const id = positive(assetId)
  return ctx.write(s => {
    const row = asset(s, id), paths = blobPaths(s, id)
    let bytes = 0
    for (const path of paths) {
      try { bytes += lstatSync(ownedFile(ctx, id, path)).size }
      catch (error) { if (!missing(error)) throw new AssetsStoreError('PATH_REJECTED', '文件路径异常，无法安全预览删除。') }
    }
    return { assetId: id, name: row.name, storageType: row.storage_type, archived: Boolean(row.archived_at), revision: row.revision,
      versionCount: s.get<{ n: number }>('SELECT COUNT(*) n FROM asset_version WHERE asset_id=?', id)!.n, fileCount: paths.length, fileBytes: bytes }
  })
}
export function deleteAsset(ctx: AssetsContext, assetId: unknown, expectedRevision: unknown, confirm: unknown): { deletedId: number; cleanupPending: boolean } {
  const id = positive(assetId), revision = positive(expectedRevision)
  if (confirm !== true) throw new AssetsStoreError('BAD_REQUEST', '永久删除需要明确确认。')
  // No filesystem mutation until SQL commits. Shared rollback references are deduplicated.
  const paths = ctx.write(s => {
    asset(s, id, revision)
    const paths = blobPaths(s, id)
    s.run('UPDATE tag SET revision=revision+1 WHERE id IN (SELECT tag_id FROM asset_tag WHERE asset_id=?)', id)
    s.run('DELETE FROM asset WHERE id=?', id)
    return paths
  })
  let pending = false
  const report = (error: unknown) => { pending = true; console.warn('[assets:delete] 文件清理待处理', { assetId: id, error }) }
  for (const path of paths) {
    try { ctx.assertCurrent(); unlinkSync(ownedFile(ctx, id, path)) }
    catch (error) { if (!missing(error)) report(error) }
  }
  try {
    ctx.assertCurrent()
    const directory = ownedDirectory(ctx, id)
    // Unknown/orphan files are kept for doctor/recovery; never recursively remove a tree.
    if (readdirSync(directory).length) pending = true
    else rmdirSync(directory)
  } catch (error) { if (!missing(error)) report(error) }
  return { deletedId: id, cleanupPending: pending }
}
