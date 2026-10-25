import { maintenanceCheckpoint, markMaintenanceCleanupFailure } from './maintenanceTask'
/** 来源观察独立于归档清单：SQLite快照不能掩盖真实主库/WAL变化。 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, dirname, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_MANIFEST_LIMITS, isExcludedFromBackup } from './manifest'

export class BackupSourceError extends Error {
  constructor(readonly code: 'SOURCE_CHANGED' | 'SOURCE_UNREADABLE' | 'INVALID_DESTINATION', message: string) { super(message) }
}
interface SourceEntry {
  path: string
  kind: 'file' | 'directory'
  dev: number
  ino: number
  size: number
  mtime: number
  ctime: number
  sha256: string
}
export interface BackupSourceObservation { canonicalRoot: string; entries: SourceEntry[] }

function stamp(path: string, stat: Stats): SourceEntry {
  return { path, kind: stat.isDirectory() ? 'directory' : 'file', dev: stat.dev, ino: stat.ino,
    // 运行锁/SHM变化可能改变父目录时间；目录只比较身份和实际遍历集合。
    size: stat.isDirectory() ? 0 : stat.size, mtime: stat.isDirectory() ? 0 : stat.mtimeMs,
    ctime: stat.isDirectory() ? 0 : stat.ctimeMs, sha256: '' }
}
function changed(): never { throw new BackupSourceError('SOURCE_CHANGED', '备份期间来源发生变化，请停止其它写入后重试。') }
function assertStamp(before: SourceEntry, after: SourceEntry): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) changed()
}
function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** 不存在的输出也按最近存在祖先解析，拒绝经junction绕回来源。 */
function canonicalFuture(path: string): string {
  let ancestor = resolve(path)
  for (;;) {
    try {
      lstatSync(ancestor)
      return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
}
export function assertBackupPathsOutsideSource(root: string, paths: string[]): void {
  const source = realpathSync(root)
  for (const path of paths) {
    if (inside(resolve(root), resolve(path)) || inside(source, canonicalFuture(path))) {
      throw new BackupSourceError('INVALID_DESTINATION', '备份与暂存位置必须在来源空间之外。')
    }
  }
}

/** 超限排除文件只记录身份/大小/时间，不额外读取大文件内容。 */
export async function captureBackupSource(
  root: string,
  maxFileBytes = DEFAULT_MANIFEST_LIMITS.maxFileBytes,
  maxEntries = DEFAULT_MANIFEST_LIMITS.maxEntries
): Promise<BackupSourceObservation> {
  try {
    const canonicalRoot = realpathSync(root)
    const entries: SourceEntry[] = []
    const children = new Map<string, string[]>()
    const observed = (path: string): boolean => {
      const lower = path.toLowerCase()
      return !isExcludedFromBackup(path) || lower === '.mimir/assets/assets.db-wal' || lower === '.mimir/assets/assets.db-journal'
    }
    const childNames = (absolute: string, path: string) => readdirSync(absolute).sort()
      .filter(name => observed(path ? `${path}/${name}` : name))
    const visit = async (absolute: string, path: string): Promise<void> => {
      await maintenanceCheckpoint()
      // WAL/journal不入归档，但它们的变化仍可能改变数据库；SHM仅为协调数据。
      if (path && !observed(path)) return
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) changed()
      const before = stamp(path, stat)
      if (stat.isDirectory()) {
        entries.push(before)
        if (entries.length > maxEntries + 1) throw new Error('来源观察条目超过上限')
        const names = childNames(absolute, path)
        children.set(path, names)
        for (const name of names) {
          await visit(join(absolute, name), path ? `${path}/${name}` : name)
        }
      } else {
        if (stat.size <= maxFileBytes) {
          // 单一所有者负责关闭：带AbortSignal的ReadStream销毁时可能先关闭外传fd。
          const handle = await open(absolute, 'r')
          try {
            assertStamp(before, stamp(path, await handle.stat()))
            const hash = createHash('sha256')
            let bytes = 0
            const buffer = Buffer.allocUnsafe(64 * 1024)
            for (;;) {
              await maintenanceCheckpoint()
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
              if (!bytesRead) break
              bytes += bytesRead
              if (bytes > stat.size) changed()
              hash.update(buffer.subarray(0, bytesRead))
            }
            if (bytes !== stat.size) changed()
            assertStamp(before, stamp(path, await handle.stat()))
            before.sha256 = hash.digest('hex')
          } finally { try { await handle.close() } catch (error) { markMaintenanceCleanupFailure(); throw error } }
        }
        // 摘要单独比较；这里复核路径仍指向刚读过的文件。
        assertStamp({ ...before, sha256: '' }, stamp(path, lstatSync(absolute)))
        entries.push(before)
        if (entries.length > maxEntries + 1) throw new Error('来源观察条目超过上限')
      }
      if (stat.isDirectory()) assertStamp(before, stamp(path, lstatSync(absolute)))
    }
    await visit(resolve(root), '')
    // Hash期间允许事件循环运行；全部读完后同步复核早先读完的文件和目录集合，
    // 防止在最终遍历中追加文件或回头修改已经读过的文件而漏检。
    for (const entry of entries) {
      const absolute = join(root, entry.path)
      assertStamp({ ...entry, sha256: '' }, stamp(entry.path, lstatSync(absolute)))
      if (entry.kind === 'directory' && JSON.stringify(children.get(entry.path)) !== JSON.stringify(childNames(absolute, entry.path))) changed()
    }
    if (realpathSync(root) !== canonicalRoot) changed()
    return { canonicalRoot, entries }
  } catch (error) {
    if (error instanceof BackupSourceError) throw error
    throw new BackupSourceError('SOURCE_UNREADABLE', `无法完整复核备份来源：${(error as Error).message}`)
  }
}
export function assertBackupSourceUnchanged(before: BackupSourceObservation, after: BackupSourceObservation): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) changed()
}
