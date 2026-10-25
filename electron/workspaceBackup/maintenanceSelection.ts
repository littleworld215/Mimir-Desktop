import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { assertRestoreDirectory, assertRestoreIdentity, restoreRootIdentity, sameRestorePath } from './restoreFingerprint'
import { maintenanceCheckpoint } from './maintenanceTask'
import type { RestoreRequest } from './restoreMain'

class SelectionError extends Error {
  constructor(readonly code: string) { super('恢复选择无效或选择后的资料发生变化，请重新选择。') }
}
export interface RestoreSelectionDialogs {
  assertLocal?(path: string): void
  pickArchive(suggestion: string): Promise<string | undefined>
  pickTarget(suggestion: string): Promise<string | undefined>
}
export interface SelectedRestore { request: RestoreRequest; assertUnchanged(): void }
/** 文本路径仅供原生窗口建议；执行位置只来自两个原生选择结果。 */
export async function selectRestoreRequest(value: unknown, dialogs: RestoreSelectionDialogs): Promise<SelectedRestore | null> {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'archivePath,spaceName,targetRoot'
    || typeof v.archivePath !== 'string' || typeof v.targetRoot !== 'string' || typeof v.spaceName !== 'string'
    || !v.spaceName.trim() || v.spaceName.length > 120 || /[\x00-\x1f]/.test(v.spaceName)
    || v.archivePath.length > 32700 || v.targetRoot.length > 32700) throw new SelectionError('INVALID_REQUEST')
  await maintenanceCheckpoint()
  const archive = await dialogs.pickArchive(v.archivePath)
  await maintenanceCheckpoint()
  if (!archive) return null
  if (!isAbsolute(archive)) throw new SelectionError('INVALID_TARGET')
  const archivePath = resolve(archive)
  assertRestoreDirectory(dirname(archivePath))
  const stamp = () => {
    const s = lstatSync(archivePath, { bigint: true })
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || !sameRestorePath(realpathSync(archivePath), archivePath)) throw new SelectionError('SELECTION_CHANGED')
    return `${s.dev}:${s.ino}:${s.birthtimeNs}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  }
  const archiveIdentity = stamp()
  const target = await dialogs.pickTarget(v.targetRoot)
  await maintenanceCheckpoint()
  if (!target) return null
  if (!isAbsolute(target)) throw new SelectionError('INVALID_TARGET')
  const targetRoot = resolve(target), parent = dirname(targetRoot), parentIdentity = restoreRootIdentity(parent)
  dialogs.assertLocal?.(dirname(archivePath))
  dialogs.assertLocal?.(parent)
  if (existsSync(targetRoot)) throw new SelectionError('TARGET_EXISTS')
  const assertUnchanged = () => {
    assertRestoreDirectory(dirname(archivePath))
    assertRestoreIdentity(parent, parentIdentity)
    if (stamp() !== archiveIdentity) throw new SelectionError('SELECTION_CHANGED')
    if (existsSync(targetRoot)) throw new SelectionError('TARGET_EXISTS')
  }
  assertUnchanged()
  return { request: { archivePath, targetRoot, spaceName: v.spaceName.trim() }, assertUnchanged }
}
