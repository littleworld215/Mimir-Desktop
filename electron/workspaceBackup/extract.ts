/** 安全落地：读取侧重新执行完整元数据/实际流量限制，预验结果不是当前归档的授权。 */
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertArchivePathWithinRoot } from './verify'
import { MANIFEST_IN_ARCHIVE, type ArchiveManifest } from './archiveFormat'
import { ArchiveByteBudget, ArchiveInventory, VerifyError, resolveArchiveLimits, type ArchiveReadLimits } from './archivePolicy'
import { assertEmptyDirectory, consumeArchiveEntry, openArchive, recheckManifest, scanArchive, walkArchive } from './archiveReader'
import { RestoreError } from './restoreContracts'

export interface ExtractOptions {
  readonly archivePath: string
  readonly stagingRoot: string
  readonly maxEntries?: number
  readonly limits?: Partial<ArchiveReadLimits>
}
export interface ExtractResult {
  readonly files: number
  readonly directories: number
  readonly bytes: number
  readonly manifest: ArchiveManifest
}

export async function extractToStaging(options: ExtractOptions): Promise<ExtractResult> {
  const stagingRoot = resolve(options.stagingRoot)
  if (!existsSync(stagingRoot)) throw new RestoreError('EXTRACT_FAILED', '暂存根不存在（须先独占创建）：' + options.stagingRoot)
  try {
    const limits = resolveArchiveLimits({ ...options.limits, ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }) })
    const { manifest, manifestSha256 } = await scanArchive(options.archivePath, limits)
    const declared = new Map(manifest.entries.map(item => [item.path, item]))
    const inventory = new ArchiveInventory(limits)
    const budget = new ArchiveByteBudget(limits.maxTotalBytes, 'TOTAL_LIMIT')
    let files = 0
    let directories = 0
    const handle = await openArchive(options.archivePath, limits)
    try {
      await walkArchive(handle, async (entry, signal) => {
        const item = inventory.accept(entry)
        assertArchivePathWithinRoot(item.path, stagingRoot)
        if (item.path === MANIFEST_IN_ARCHIVE) {
          await recheckManifest(handle.zip, entry, limits, signal, manifestSha256)
          return
        }
        const expected = declared.get(item.path)
        if (!expected) throw new VerifyError('EXTRA_ENTRY', '归档含清单未声明的条目：' + item.path)
        if (item.kind !== expected.kind) throw new VerifyError('UNSAFE_ENTRY', '归档条目类型与清单不符：' + item.path)
        if (item.size !== expected.size) throw new VerifyError('SIZE_MISMATCH', '条目字节数不符：' + item.path)
        const destination = join(stagingRoot, item.path)
        if (item.kind === 'directory') { await assertEmptyDirectory(handle.zip, entry, signal); mkdirSync(destination, { recursive: true }); directories++; return }
        mkdirSync(dirname(destination), { recursive: true })
        const hash = createHash('sha256')
        await consumeArchiveEntry(handle.zip, entry, budget, () => createWriteStream(destination, { flags: 'wx' }), chunk => { hash.update(chunk) }, signal)
        if (hash.digest('hex') !== expected.sha256) throw new VerifyError('DIGEST_MISMATCH', '条目摘要不符：' + item.path)
        files++
      })
      inventory.match(manifest)
    } finally { await handle.close() }
    return { files, directories, bytes: budget.total, manifest }
  } catch (error) {
    if (error instanceof RestoreError) throw error
    if (error instanceof VerifyError) throw new RestoreError(error.code, error.message)
    throw new RestoreError('EXTRACT_FAILED', '解压失败：' + (error instanceof Error ? error.message : '未知错误'))
  }
}
export { RestoreError as ExtractError }
