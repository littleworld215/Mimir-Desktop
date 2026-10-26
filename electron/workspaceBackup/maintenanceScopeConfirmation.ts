import type { BackupScopeDetailsPage, BackupScopeSummary } from '../../shared/workspaceBackupMetadata'
import type { SelectedRestore } from './maintenanceSelection'
import { readBoundArchiveManifest } from './archiveScope'
import { pageBackupScope } from './archiveMetadata'
import { maintenanceCheckpoint } from './maintenanceTask'

export interface ScopeConfirmationDialogs {
  confirm(summary: BackupScopeSummary): Promise<'cancel' | 'details' | 'continue'>
  showDetails(page: BackupScopeDetailsPage): Promise<'back' | 'next'>
}
export async function confirmSelectedRestoreScope(selected: SelectedRestore, dialogs: ScopeConfirmationDialogs): Promise<BackupScopeSummary | null> {
  const checkpoint = async () => { await maintenanceCheckpoint(); selected.assertUnchanged() }
  await checkpoint()
  const { manifest, receipt } = await readBoundArchiveManifest(selected.request.archivePath)
  await checkpoint()
  for (;;) {
    const decision = await dialogs.confirm(structuredClone(receipt.scope))
    await checkpoint()
    if (decision === 'continue') return receipt.scope
    if (decision !== 'details') return null
    let offset = 0
    for (;;) {
      const page = pageBackupScope(manifest.metadata, offset)
      const next = await dialogs.showDetails(page)
      await checkpoint()
      if (next !== 'next' || page.nextOffset === undefined) break
      offset = page.nextOffset
    }
  }
}
