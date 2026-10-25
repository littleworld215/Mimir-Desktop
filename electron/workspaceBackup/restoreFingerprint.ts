import { maintenanceCheckpoint, checkMaintenanceCancellation, markMaintenanceCleanupFailure } from './maintenanceTask'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { RestoreError } from './restoreContracts'

export interface RestoreRootIdentity { dev: string; ino: string; birth: string }
export interface RestoreFingerprint { digest: string; entries: number; totalBytes: number }
const volatileLocks = new Set(['.mimir/workspace.writer-lock', '.mimir/assets/assets.db.writer-lock'])
export function sameRestorePath(a: string, b: string): boolean {
  const key = (value: string) => {
    const path = resolve(value).replace(/\\/g, '/')
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  return key(a) === key(b)
}
export function assertRestoreDirectory(path: string): void {
  if (!isAbsolute(path)) throw new RestoreError('RECHECK_FAILED', '恢复目录身份无法确认。')
  let current = resolve(path)
  for (;;) {
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameRestorePath(realpathSync(current), current)) {
      throw new RestoreError('RECHECK_FAILED', '恢复目录或其父目录包含链接或已改变。')
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
export function restoreRootIdentity(root: string): RestoreRootIdentity {
  try {
    assertRestoreDirectory(root)
    const stat = lstatSync(root, { bigint: true })
    if (stat.ino === 0n) throw Error('unavailable identity')
    return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) }
  } catch { throw new RestoreError('RECHECK_FAILED', '无法核对恢复目录的创建身份，资料已保留。') }
}
export function assertRestoreIdentity(root: string, identity: RestoreRootIdentity): void {
  const current = restoreRootIdentity(root)
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.birth !== identity.birth) {
    throw new RestoreError('RECHECK_FAILED', '恢复目录身份已变化，拒绝继续操作。')
  }
}

/** 内容摘要不含本机路径或正文；只有受管活锁被排除，并在操作时另核凭据。 */
export async function fingerprintRestoredRoot(root: string, expected = restoreRootIdentity(root)): Promise<RestoreFingerprint> {
  const combined = createHash('sha256')
  let entries = 0, totalBytes = 0
  const changed = () => new RestoreError('RECHECK_FAILED', '恢复资料无法完整核对或在核对期间变化，资料已保留。')
  const stamp = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  const walk = async (directory: string, relative: string): Promise<void> => {
    const before = lstatSync(directory, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory() || !sameRestorePath(realpathSync(directory), directory)) throw changed()
    const names = readdirSync(directory).sort()
    for (const name of names) {
      await maintenanceCheckpoint()
      const file = join(directory, name), path = relative ? `${relative}/${name}` : name
      const stat = lstatSync(file, { bigint: true })
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw changed()
      if (volatileLocks.has(process.platform === 'win32' ? path.toLowerCase() : path)) {
        if (!stat.isFile() || stat.nlink !== 1n) throw changed()
        continue
      }
      entries += 1
      if (entries > 100_000) throw changed()
      if (stat.isDirectory()) {
        combined.update(JSON.stringify([path, 'directory']) + '\n')
        await walk(file, path)
        continue
      }
      if (stat.nlink !== 1n || stat.size > 1_099_511_627_776n) throw changed()
      totalBytes += Number(stat.size)
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 1_099_511_627_776) throw changed()
      const content = createHash('sha256'), handle = await open(file, 'r')
      try {
        if (stamp(await handle.stat({ bigint: true })) !== stamp(stat)) throw changed()
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let size = 0
        for (;;) {
          checkMaintenanceCancellation()
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
          if (!bytesRead) break
          size += bytesRead
          if (size > Number(stat.size)) throw changed()
          content.update(buffer.subarray(0, bytesRead))
        }
        if (size !== Number(stat.size) || stamp(await handle.stat({ bigint: true })) !== stamp(stat)) throw changed()
      } finally { try { await handle.close() } catch (error) { markMaintenanceCleanupFailure(); throw error } }
      if (stamp(lstatSync(file, { bigint: true })) !== stamp(stat)) throw changed()
      combined.update(JSON.stringify([path, 'file', Number(stat.size), content.digest('hex')]) + '\n')
    }
    if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(names) || stamp(lstatSync(directory, { bigint: true })) !== stamp(before)) throw changed()
  }
  try {
    assertRestoreIdentity(root, expected)
    // A volume root is never a restore product, even if a forged record names it.
    if (sameRestorePath(root, parse(root).root)) throw changed()
    await walk(root, '')
    assertRestoreIdentity(root, expected)
    return { digest: combined.digest('hex'), entries, totalBytes }
  } catch { checkMaintenanceCancellation(); throw changed() }
}
