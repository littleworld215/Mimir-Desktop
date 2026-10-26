/** 清单观察票据绑定文件和父目录；读取说明从不冒充逐字节验包。 */
import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { BackupScopeSummary } from '../../shared/workspaceBackupMetadata'
import { assertRestoreDirectory, restoreRootIdentity, sameRestorePath } from './restoreFingerprint'
import { readArchiveManifest } from './restoreArchive'
import { summarizeBackupScope } from './archiveMetadata'
import { verifyBackup } from './verify'

export interface ArchiveScopeReceipt { fileStamp: string; manifestSha256: string; scope: BackupScopeSummary }
export function archiveScopeStamp(path: string): string {
  assertRestoreDirectory(dirname(path))
  const parent = restoreRootIdentity(dirname(path)), s = lstatSync(path, { bigint: true })
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || !sameRestorePath(realpathSync(path), path)) throw scopeChanged()
  return JSON.stringify([String(s.dev), String(s.ino), String(s.birthtimeNs), String(s.size), String(s.mtimeNs), String(s.ctimeNs), parent])
}
function scopeChanged(): Error { return Object.assign(new Error('归档或其目录已变化，请重新读取清单。'), { code: 'SELECTION_CHANGED' }) }
export async function readBoundArchiveManifest(path: string) {
  const before = archiveScopeStamp(path), manifest = await readArchiveManifest(path)
  if (archiveScopeStamp(path) !== before) throw scopeChanged()
  const receipt: ArchiveScopeReceipt = { fileStamp: before,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), scope: summarizeBackupScope(manifest.metadata) }
  return { manifest, receipt }
}
export async function readArchiveScopeReceipt(path: string): Promise<ArchiveScopeReceipt> { return (await readBoundArchiveManifest(path)).receipt }
export async function verifyBackupWithScope(path: string): Promise<{ verification: 'passed'; scope: BackupScopeSummary }> {
  const before = await readArchiveScopeReceipt(path)
  await verifyBackup(path)
  const after = await readArchiveScopeReceipt(path)
  if (before.fileStamp !== after.fileStamp || before.manifestSha256 !== after.manifestSha256) throw scopeChanged()
  return { verification: 'passed', scope: after.scope }
}
