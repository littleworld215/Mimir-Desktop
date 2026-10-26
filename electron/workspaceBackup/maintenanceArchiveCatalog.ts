import { randomUUID } from 'node:crypto'
import type { BackupScopeDetailsPage } from '../../shared/workspaceBackupMetadata'
import type { MaintenanceArchiveCandidate } from '../../shared/workspaceBackupContracts'
import type { RestoreArchiveCandidate } from './restoreMain'
import { archiveScopeStamp, readBoundArchiveManifest, type ArchiveScopeReceipt } from './archiveScope'
import { pageBackupScope } from './archiveMetadata'

const failure = (code: string) => Object.assign(new Error('归档说明请求无效或清单已过期，请重新读取。'), { code })
/** 每次概览替换整份当前窗口目录，不累计旧授权，不接受路径回退。 */
export class MaintenanceArchiveCatalog {
  private generation = 0
  private entries = new Map<string, { path: string; receipt: ArchiveScopeReceipt }>()
  replace(candidates: readonly RestoreArchiveCandidate[]): MaintenanceArchiveCandidate[] {
    this.generation++; this.entries.clear()
    return candidates.map(candidate => {
      const dto: MaintenanceArchiveCandidate = { path: candidate.path, name: candidate.name, bytes: candidate.bytes, modifiedAt: candidate.modifiedAt, remappable: candidate.remappable }
      if (!candidate.scopeReceipt) return { ...dto, scopeUnavailable: true }
      const id = randomUUID(), receipt = structuredClone(candidate.scopeReceipt)
      this.entries.set(id, { path: candidate.path, receipt })
      return { ...dto, archiveId: id, scope: structuredClone(receipt.scope) }
    })
  }
  async read(request: unknown): Promise<BackupScopeDetailsPage> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('INVALID_REQUEST')
    const value = request as Record<string, unknown>, offset = value.offset === undefined ? 0 : value.offset
    if (Object.keys(value).some(k => k !== 'archiveId' && k !== 'offset') || typeof value.archiveId !== 'string' || value.archiveId.length > 512
      || !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 100_000) throw failure('INVALID_REQUEST')
    const row = this.entries.get(value.archiveId), generation = this.generation
    if (!row) throw failure('SELECTION_CHANGED')
    if (archiveScopeStamp(row.path) !== row.receipt.fileStamp) throw failure('SELECTION_CHANGED')
    const current = await readBoundArchiveManifest(row.path)
    if (this.generation !== generation || current.receipt.fileStamp !== row.receipt.fileStamp || current.receipt.manifestSha256 !== row.receipt.manifestSha256) throw failure('SELECTION_CHANGED')
    return pageBackupScope(current.manifest.metadata, Number(offset))
  }
}
