/** 独立验包：先限流扫描元数据，再逐文件流式计数/摘要；两遍都等待真实关闭。 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { Writable } from 'node:stream'
import { MANIFEST_IN_ARCHIVE } from './archiveFormat'
import { ArchiveByteBudget, ArchiveInventory, VerifyError, resolveArchiveLimits, type ArchiveLimitsInput } from './archivePolicy'
import { assertEmptyDirectory, consumeArchiveEntry, openArchive, recheckManifest, scanArchive, walkArchive } from './archiveReader'

export interface VerifyResult { entries: number; totalBytes: number; formatVersion: number }

/** 旧数字参数仍为条目数；内部可选限额只能收紧，渲染桥无覆盖入口。 */
export async function verifyBackup(archivePath: string, input?: ArchiveLimitsInput): Promise<VerifyResult> {
  const limits = resolveArchiveLimits(input)
  const { manifest, manifestSha256 } = await scanArchive(archivePath, limits)
  const expected = new Map(manifest.entries.map(item => [item.path, item]))
  const budget = new ArchiveByteBudget(limits.maxTotalBytes, 'TOTAL_LIMIT')
  const inventory = new ArchiveInventory(limits)
  const handle = await openArchive(archivePath, limits)
  try {
    await walkArchive(handle, async (entry, signal) => {
      const item = inventory.accept(entry)
      if (item.path === MANIFEST_IN_ARCHIVE) {
        await recheckManifest(handle.zip, entry, limits, signal, manifestSha256)
        return
      }
      const declared = expected.get(item.path)
      if (!declared) throw new VerifyError('EXTRA_ENTRY', '归档含清单未声明的条目：' + item.path)
      if (item.kind !== declared.kind) throw new VerifyError('UNSAFE_ENTRY', '归档条目类型与清单不符：' + item.path)
      if (item.kind === 'directory') { await assertEmptyDirectory(handle.zip, entry, signal); return }
      const hash = createHash('sha256')
      let size = 0
      await consumeArchiveEntry(handle.zip, entry, budget, () => new Writable({ write(_chunk, _encoding, done) { done() } }),
        chunk => { hash.update(chunk); size += chunk.length }, signal)
      if (size !== declared.size) throw new VerifyError('SIZE_MISMATCH', '条目字节数不符：' + item.path)
      if (hash.digest('hex') !== declared.sha256) throw new VerifyError('DIGEST_MISMATCH', '条目摘要不符：' + item.path)
    })
    inventory.match(manifest)
  } finally { await handle.close() }
  return { entries: manifest.entries.length, totalBytes: budget.total, formatVersion: manifest.version }
}

/** 归档路径不得逃逸出解压根（供恢复批次复用）。 */
export function assertArchivePathWithinRoot(entryPath: string, root: string): void {
  const normalized = entryPath.split('\\').join('/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new VerifyError('PATH_ESCAPE', `归档条目为绝对路径：${entryPath}`)
  }
  if (normalized.split('/').includes('..')) throw new VerifyError('PATH_ESCAPE', `归档条目含上级引用：${entryPath}`)
  const target = resolve(root, normalized)
  const rootResolved = resolve(root)
  const rel = target.slice(rootResolved.length)
  if (target !== rootResolved && !rel.startsWith('/') && !rel.startsWith('\\')) {
    throw new VerifyError('PATH_ESCAPE', `归档条目逃逸出根目录：${entryPath}`)
  }
}

export { VerifyError }
/** 只读探测：归档是否可打开（不逐条校验内容）。 */
export async function canOpenBackup(archivePath: string): Promise<boolean> {
  try { await (await openArchive(archivePath, { maxEntries: 100_000 })).close(); return true } catch { return false }
}
