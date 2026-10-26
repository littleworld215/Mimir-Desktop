/** 只读检查新私有快照，历史平铺快照仅报告未知，不迁移/收权/读取凭据正文。 */
import { lstatSync, opendirSync } from 'node:fs'
import { join } from 'node:path'
import type { DoctorCheck } from '../../shared/workspaceBackupContracts'
import { assertPlainRegistryPath, verifyPrivatePath } from './privateRegistryAcl'
import { REGISTRY_PRIVATE_DIRECTORY } from './protectedRegistry'

function absent(path: string): boolean {
  try { lstatSync(path); return false } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}
export function scanRegistrySnapshotProtection(homeDir: string): DoctorCheck {
  const control = join(homeDir, '.mimir'), directory = join(control, REGISTRY_PRIVATE_DIRECTORY)
  const facts = { legacy: 0, verified: 0, failed: 0, unchecked: 0 }
  const result = (severity: DoctorCheck['severity'], detail: string): DoctorCheck => ({ id: 'REGISTRY_SNAPSHOT_PROTECTION', title: '本机注册快照保护', severity, detail, facts })
  const deadline = performance.now() + 10_000
  try {
    if (absent(control)) return result('ok', '尚无本机注册快照，无可检查项；未创建目录或修改权限。')
    assertPlainRegistryPath(control, 'directory')
    const listing = opendirSync(control)
    try {
      let count = 0
      for (let item = listing.readSync(); item; item = listing.readSync()) {
        if (++count > 100_000) { facts.unchecked++; break }
        if (item.name.startsWith('store.json.pre-restore-') && item.name.endsWith('.bak')) facts.legacy++
      }
    } finally { listing.closeSync() }
    if (absent(directory)) return result(facts.unchecked ? 'warning' : facts.legacy ? 'notice' : 'ok', facts.legacy ? '历史平铺快照保护状态未知，未移动、读取正文或修改权限。' : '尚无新私有注册快照，无可检查项；未创建目录或修改权限。')
    verifyPrivatePath(directory, 'directory', deadline)
    const files = opendirSync(directory)
    try {
      let count = 0
      for (let item = files.readSync(); item; item = files.readSync()) {
        if (++count > 100_000) { facts.unchecked++; break }
        if (!item.isFile() || !item.name.startsWith('store.json.pre-restore-') || !item.name.endsWith('.bak') || performance.now() >= deadline) { facts.unchecked++; continue }
        try { verifyPrivatePath(join(directory, item.name), 'file', deadline); facts.verified++ }
        catch { facts.failed++ }
      }
    } finally { files.closeSync() }
    return result(facts.failed ? 'error' : facts.unchecked ? 'warning' : facts.legacy ? 'notice' : 'ok',
      `已验证新快照权限 ${facts.verified} 份；失败 ${facts.failed}，未检查 ${facts.unchecked}，历史保护未知 ${facts.legacy}。未读取凭据正文或修改权限。`)
  } catch { facts.failed++; return result('error', '新私有快照保护未通过只读验证，未自动修复权限；请保留资料并检查维护记录。') }
}
