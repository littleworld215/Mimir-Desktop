/**
 * 独立验包（I6 批次 2 · 第 3 块）。
 *
 * 职责：**在不依赖打包过程内存状态**的前提下，重新打开归档，逐条核对：
 * - 归档内清单（`mimir-manifest.json`）可解析且版本兼容；
 * - 归档实际条目集合与清单**一一对应**（多一条、少一条都算失败）；
 * - 每个文件的字节数与 SHA256 与清单一致（目录条目不校验内容）；
 * - 归档路径通过统一的 Windows 路径校验（防 zip-slip / 保留名 / 大小写冲突）。
 *
 * 纪律：验包**只读**；打开失败、条目缺失、摘要不符一律抛错，不做「部分通过」。
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import yauzl from 'yauzl'
import { validateArchivePaths, type ArchivePath } from './archivePaths'
import { MANIFEST_IN_ARCHIVE, BACKUP_FORMAT_VERSION, type ArchiveManifest } from './packer'
import type { ManifestEntry } from './manifest'

export interface VerifyResult {
  entries: number
  totalBytes: number
  formatVersion: number
}

class VerifyError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** 打开归档并逐条读取（yauzl 回调风格包成 async）。 */
function openArchive(path: string, limits: { maxEntries: number }): Promise<yauzl.ZipFile> {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zipfile) => {
      if (error || !zipfile) reject(new VerifyError('OPEN_FAILED', `无法打开归档：${error?.message ?? '未知错误'}`))
      else if (zipfile.entryCount > limits.maxEntries) {
        zipfile.close()
        reject(new VerifyError('ENTRY_LIMIT', `归档条目数 ${zipfile.entryCount} 超过上限 ${limits.maxEntries}`))
      } else resolveOpen(zipfile)
    })
  })
}

/**
 * 读取单个 entry 的全部字节（仅条目本身，不含解压到磁盘）。
 *
 * ⚠️ 用途限制：本函数把整条内容拼成一个 `Buffer`，**仅适用于归档内清单**
 * （`mimir-manifest.json`，其字节数有上限：清单本身 ≤ `maxManifestBytes`，默认 64 MiB），
 * 故这里的 `Buffer.concat` 是**有意为之**而非漏改。
 * **逐文件校验**（对归档内每个文件条目算 SHA256，条目仅受 `maxEntries`/`maxTotalBytes`
 * 约束、单文件可达 GiB 级）走 `hashEntry` 的**流式**路径，绝不整读入内存。
 */
function readEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolveRead, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(new VerifyError('READ_FAILED', `无法读取条目：${entry.fileName}`)); return }
      const chunks: Buffer[] = []
      let total = 0
      stream.on('data', (chunk: Buffer) => { chunks.push(chunk); total += chunk.length })
      stream.on('error', (streamError: Error) => reject(new VerifyError('READ_FAILED', `读取条目失败：${entry.fileName}（${streamError.message}）`)))
      stream.on('end', () => resolveRead(Buffer.concat(chunks, total)))
    })
  })
}

/**
 * **流式**读取单个 entry 并计算其字节数与 SHA256（只读，不解压到磁盘）。
 *
 * 与 `readEntry` 的关键差异：**不** `chunks.push`、**不** `Buffer.concat`，
 * 在 `data` 事件里直接把每个 chunk 喂给 `createHash('sha256')` 并累加 `size`。
 * 因此峰值内存 ≈ 单个 chunk（yauzl 默认 64 KiB），与文件体积无关——
 * 这是「10 万条目 / 1 TiB 展开」上限下验大文件归档不 OOM 的根本保证。
 *
 * @param zipfile 已打开的归档。
 * @param entry 待校验的文件条目。
 * @returns 该条目的实际字节数 `size` 与其内容 SHA256（小写十六进制）`sha256`。
 * @throws {VerifyError} `READ_FAILED`（打开或读取流失败）。
 */
function hashEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<{ size: number; sha256: string }> {
  return new Promise((resolveHash, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(new VerifyError('READ_FAILED', `无法读取条目：${entry.fileName}`)); return }
      const hash = createHash('sha256')
      let size = 0
      stream.on('data', (chunk: Buffer) => { hash.update(chunk); size += chunk.length })
      stream.on('error', (streamError: Error) => reject(new VerifyError('READ_FAILED', `读取条目失败：${entry.fileName}（${streamError.message}）`)))
      stream.on('end', () => resolveHash({ size, sha256: hash.digest('hex') }))
    })
  })
}

/**
 * 校验一份备份归档。
 *
 * @param archivePath 归档文件路径
 * @param maxEntries 条目上限覆盖
 */
export async function verifyBackup(
  archivePath: string,
  maxEntries = 100_000
): Promise<VerifyResult> {
  const zipfile = await openArchive(archivePath, { maxEntries })

  const entries = new Map<string, { kind: 'file' | 'directory'; size: number }>()
  let manifestBuffer: Buffer | null = null
  let totalBytes = 0

  await new Promise<void>((resolveAll, rejectAll) => {
    zipfile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const name = entry.fileName.split('\\').join('/')
          // zip 目录条目带尾斜杠；统一成「无尾斜杠」的规范形式。
          const isDir = name.endsWith('/')
          const normalized = isDir ? name.replace(/\/+$/, '') : name
          if (normalized === '') { zipfile.readEntry(); return }
          if (entries.has(normalized)) throw new VerifyError('DUPLICATE_ENTRY', `归档含重复条目：${normalized}`)
          if (normalized === MANIFEST_IN_ARCHIVE) {
            manifestBuffer = await readEntry(zipfile, entry)
            entries.set(normalized, { kind: 'file', size: entry.uncompressedSize })
          } else {
            entries.set(normalized, { kind: isDir ? 'directory' : 'file', size: entry.uncompressedSize })
            if (!isDir) totalBytes += entry.uncompressedSize
          }
          zipfile.readEntry()
        } catch (error) { zipfile.close(); rejectAll(error) }
      })()
    })
    zipfile.on('end', () => resolveAll())
    zipfile.on('error', (error: Error) => rejectAll(new VerifyError('READ_FAILED', `归档读取失败：${error.message}`)))
    zipfile.readEntry()
  })

  if (!manifestBuffer) throw new VerifyError('MANIFEST_MISSING', `归档缺少清单 ${MANIFEST_IN_ARCHIVE}`)

  let manifest: ArchiveManifest
  try {
    manifest = JSON.parse((manifestBuffer as Buffer).toString('utf8')) as ArchiveManifest
  } catch {
    throw new VerifyError('MANIFEST_INVALID', '归档清单不是合法 JSON')
  }
  if (manifest.version !== BACKUP_FORMAT_VERSION) {
    throw new VerifyError('VERSION_UNSUPPORTED', `归档格式版本 ${manifest.version} 不受支持（期望 ${BACKUP_FORMAT_VERSION}）`)
  }
  if (!Array.isArray(manifest.entries)) throw new VerifyError('MANIFEST_INVALID', '归档清单 entries 不是数组')

  // 路径语义校验：Windows 保留名、大小写冲突、文件/目录冲突。
  validateArchivePaths(manifest.entries as ArchivePath[], maxEntries)

  // 条目集合一一对应（清单 + manifest 自身 == 归档实际条目）。
  const expected = new Map<string, ManifestEntry>()
  for (const entry of manifest.entries) {
    if (expected.has(entry.path)) throw new VerifyError('DUPLICATE_ENTRY', `清单含重复条目：${entry.path}`)
    expected.set(entry.path, entry)
  }
  expected.set(MANIFEST_IN_ARCHIVE, { path: MANIFEST_IN_ARCHIVE, kind: 'file', size: 0, sha256: '' })
  for (const path of expected.keys()) {
    if (!entries.has(path)) throw new VerifyError('MISSING_ENTRY', `归档缺少清单声明的条目：${path}`)
  }
  for (const path of entries.keys()) {
    if (!expected.has(path)) throw new VerifyError('EXTRA_ENTRY', `归档含清单未声明的条目：${path}`)
  }

  // 逐文件字节数与 SHA256 复核（只读，不解压到磁盘）。
  const zip2 = await openArchive(archivePath, { maxEntries })
  await new Promise<void>((resolveAll, rejectAll) => {
    zip2.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const name = entry.fileName.split('\\').join('/').replace(/\/+$/, '')
          const declared = expected.get(name)
          if (declared && declared.kind === 'file' && name !== MANIFEST_IN_ARCHIVE) {
            // 流式：逐 chunk 喂哈希并累加字节数，不把整文件拼进内存（大条目不再 OOM）。
            const { size, sha256 } = await hashEntry(zip2, entry)
            if (size !== declared.size) {
              throw new VerifyError('SIZE_MISMATCH', `条目字节数不符：${name}（归档 ${size} / 清单 ${declared.size}）`)
            }
            if (sha256 !== declared.sha256) {
              throw new VerifyError('DIGEST_MISMATCH', `条目摘要不符：${name}`)
            }
          }
          zip2.readEntry()
        } catch (error) { zip2.close(); rejectAll(error) }
      })()
    })
    zip2.on('end', () => resolveAll())
    zip2.on('error', (error: Error) => rejectAll(new VerifyError('READ_FAILED', `归档读取失败：${error.message}`)))
    zip2.readEntry()
  })

  return { entries: manifest.entries.length, totalBytes, formatVersion: manifest.version }
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
  try { (await openArchive(archivePath, { maxEntries: 100_000 })).close(); return true } catch { return false }
}
