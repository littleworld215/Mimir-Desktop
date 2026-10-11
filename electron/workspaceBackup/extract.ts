/**
 * 安全解压（I6 批次 3 · 第 2 块）。
 *
 * 职责：把**已经过 `verifyBackup()` 验证**的归档**流式**解压到本次暂存根，并在落地过程中
 * 逐条执行路径安全校验、逐文件按清单 `size`/`sha256` **重新计算比对**（不信任归档声明）。
 *
 * 纪律（对应设计 §2.1 / §3 / INTEGRATION-PLAN-I6 固定边界）：
 * - **不重复验包逻辑**：调用方须先跑 `verifyBackup()`；本模块只负责「安全落地」。
 * - **逐条路径校验**：每个条目落地前调 `assertArchivePathWithinRoot(entryPath, stagingRoot)`；
 *   条目集合再整体过一遍 `validateArchivePaths`（Windows 保留名/大小写/文件目录冲突）。
 * - **绝不创建链接/junction**：目录一律 `mkdir`；Node 在 Windows 上把 junction 也报
 *   `isSymbolicLink()`，故本模块**从不**调用任何 symlink 相关 API。
 * - **流式写盘**：`openReadStream` → `pipeline` 到 `createWriteStream`，同时增量 `hash.update`；
 *   **不**把整块文件读进内存（批次 2 `verify.ts` 在这点有已知局限，本模块不重蹈）。
 * - **重算比对**：写完比对期望 `size` 与实时 SHA256；不符即失败。
 */

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { assertArchivePathWithinRoot } from './verify'
import { validateArchivePaths, type ArchivePath } from './archivePaths'
import { MANIFEST_IN_ARCHIVE, type ArchiveManifest } from './packer'
import type { ManifestEntry } from './manifest'
import { RestoreError } from './restoreContracts'

export interface ExtractOptions {
  /** 归档绝对路径（须已通过 `verifyBackup`）。 */
  readonly archivePath: string
  /** 本次暂存根绝对路径（已创建、独占）。 */
  readonly stagingRoot: string
  /** 条目上限（与验包一致，默认 10 万）。 */
  readonly maxEntries?: number
}

export interface ExtractResult {
  /** 成功落地的文件条目数（不含目录与清单）。 */
  readonly files: number
  /** 落地的目录条目数。 */
  readonly directories: number
  /** 落地文件总字节。 */
  readonly bytes: number
  /** 归档内清单（供 T03 审计/T04 复用）。 */
  readonly manifest: ArchiveManifest
}

/** 打开归档（`lazyEntries`；超出条目上限即失败）。 */
function openArchive(path: string, maxEntries: number): Promise<yauzl.ZipFile> {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(new RestoreError('EXTRACT_FAILED', `无法打开归档：${error?.message ?? '未知错误'}`))
      } else if (zipfile.entryCount > maxEntries) {
        zipfile.close()
        reject(new RestoreError('ENTRY_LIMIT', `归档条目数 ${zipfile.entryCount} 超过上限 ${maxEntries}`))
      } else {
        resolveOpen(zipfile)
      }
    })
  })
}

/** 规范化条目名为「无尾斜杠」的正斜杠形式。 */
function normalizeEntryName(fileName: string): string {
  const posix = fileName.split('\\').join('/')
  return posix.endsWith('/') ? posix.replace(/\/+$/, '') : posix
}

/**
 * 流式解压单个文件条目到 `destination`，同时重算字节数与 SHA256。
 *
 * @returns 实际字节数与 SHA256
 */
async function extractFileEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destination: string
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, reject) => {
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error || !readStream) { reject(new RestoreError('EXTRACT_FAILED', `无法读取条目：${entry.fileName}`)); return }
      resolveStream(readStream)
    })
  })
  mkdirSync(dirname(destination), { recursive: true })
  // 流式：边写边算摘要，绝不整块进内存。`data` 监听与 `pipeline` 共存——
  // 二者都在同一可读流的下游，chunk 顺序一致，故 size/hash 与落盘字节一致。
  stream.on('data', (chunk: Buffer) => {
    size += chunk.length
    hash.update(chunk)
  })
  await pipeline(stream, createWriteStream(destination, { flags: 'wx' }))
  return { size, sha256: hash.digest('hex') }
}

/**
 * 读取归档内清单（第一个命中的 `mimir-manifest.json` 条目）。
 *
 * 清单可能很大（上限 64 MiB），但它是**元数据**不是用户大文件；此处按设计读入内存
 * 仅限清单本身，不违反「大文件不整块读」的约束。
 */
function readManifest(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<ArchiveManifest> {
  return new Promise((resolveManifest, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(new RestoreError('EXTRACT_FAILED', '无法读取归档清单')); return }
      const chunks: Buffer[] = []
      let total = 0
      stream.on('data', (chunk: Buffer) => { chunks.push(chunk); total += chunk.length })
      stream.on('error', (streamError: Error) => reject(new RestoreError('EXTRACT_FAILED', `清单读取失败：${streamError.message}`)))
      stream.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as ArchiveManifest
          resolveManifest(parsed)
        } catch {
          reject(new RestoreError('RECHECK_FAILED', '归档清单不是合法 JSON'))
        }
      })
    })
  })
}

/**
 * 执行一次安全解压。
 *
 * @throws RestoreError `EXTRACT_FAILED` | `ENTRY_LIMIT` | `PATH_ESCAPE` | `UNSAFE_ENTRY` |
 *                     `DIGEST_MISMATCH` | `RECHECK_FAILED`
 */
export async function extractToStaging(options: ExtractOptions): Promise<ExtractResult> {
  const { archivePath, stagingRoot, maxEntries = 100_000 } = options
  const stagingResolved = resolve(stagingRoot)
  if (!existsSync(stagingResolved)) {
    throw new RestoreError('EXTRACT_FAILED', `暂存根不存在（须先独占创建）：${stagingRoot}`)
  }

  const zipfile = await openArchive(archivePath, maxEntries)

  // 已落地的清单声明：path → ManifestEntry（用于逐文件比对）。
  const declared = new Map<string, ManifestEntry>()
  const seenPaths: ArchivePath[] = []
  let files = 0
  let directories = 0
  let bytes = 0
  // 用 holder 承载闭包内赋值：TS 无法跨回调追踪 `let x: T | null = null` 的收窄。
  const manifestHolder: { value: ArchiveManifest | null } = { value: null }

  try {
    await new Promise<void>((resolveAll, rejectAll) => {
      zipfile.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          try {
            const normalized = normalizeEntryName(entry.fileName)
            if (normalized === '') { zipfile.readEntry(); return }

            // ① 路径安全：条目名不得逃逸出暂存根（防 zip-slip）。
            assertArchivePathWithinRoot(normalized, stagingResolved)

            // ② 清单位置：归档内清单只读取、不落盘为普通文件。
            if (normalized === MANIFEST_IN_ARCHIVE) {
              manifestHolder.value = await readManifest(zipfile, entry)
              zipfile.readEntry()
              return
            }

            const isDir = entry.fileName.split('\\').join('/').endsWith('/')
            if (isDir) {
              seenPaths.push({ path: normalized, kind: 'directory' })
              validateArchivePaths(seenPaths)
              const target = join(stagingResolved, normalized)
              mkdirSync(target, { recursive: true })
              directories += 1
              zipfile.readEntry()
              return
            }

            seenPaths.push({ path: normalized, kind: 'file' })
            validateArchivePaths(seenPaths)

            const destination = join(stagingResolved, normalized)
            // 防御：解析后的绝对路径必须在暂存根之下（防 join 归一化绕过）。
            const prefix = stagingResolved.endsWith(sep) ? stagingResolved : `${stagingResolved}${sep}`
            if (!resolve(destination).startsWith(prefix)) {
              throw new RestoreError('PATH_ESCAPE', `条目逃逸出暂存根：${normalized}`)
            }

            const actual = await extractFileEntry(zipfile, entry, destination)

            // ③ 与清单声明比对（不信任归档声明）：size 与 sha256 都要重算核对。
            //    清单在归档里可能晚于文件出现，故 size/sha 校验留到清单读齐后统一做。
            declared.set(normalized, {
              path: normalized,
              kind: 'file',
              size: actual.size,
              sha256: actual.sha256
            })
            files += 1
            bytes += actual.size
            zipfile.readEntry()
          } catch (error) {
            zipfile.close()
            rejectAll(error)
          }
        })()
      })
      zipfile.on('end', () => resolveAll())
      zipfile.on('error', (error: Error) => rejectAll(new RestoreError('EXTRACT_FAILED', `归档读取失败：${error.message}`)))
      zipfile.readEntry()
    })
  } catch (error) {
    throw error instanceof RestoreError ? error : new RestoreError('EXTRACT_FAILED', `解压失败：${error instanceof Error ? error.message : '未知错误'}`)
  }

  const manifest = manifestHolder.value
  if (manifest === null) throw new RestoreError('RECHECK_FAILED', `归档缺少清单 ${MANIFEST_IN_ARCHIVE}`)

  // ④ 以清单为基准，逐文件核对 size 与 sha256（此时已全部落盘并有实测值）。
  const expected = new Map<string, ManifestEntry>()
  for (const item of manifest.entries) expected.set(item.path, item)
  for (const item of manifest.entries) {
    if (item.kind !== 'file') continue
    const actual = declared.get(item.path)
    if (actual === undefined) {
      throw new RestoreError('RECHECK_FAILED', `归档缺少清单声明的文件：${item.path}`)
    }
    if (actual.size !== item.size) {
      throw new RestoreError('DIGEST_MISMATCH', `条目字节数不符：${item.path}（实际 ${actual.size} / 清单 ${item.size}）`)
    }
    if (actual.sha256 !== item.sha256) {
      throw new RestoreError('DIGEST_MISMATCH', `条目摘要不符：${item.path}`)
    }
  }
  // 反向：落地文件不得多于清单声明（防夹带）。
  for (const path of declared.keys()) {
    if (!expected.has(path)) throw new RestoreError('RECHECK_FAILED', `归档含清单未声明的文件：${path}`)
  }

  return { files, directories, bytes, manifest }
}

export { RestoreError as ExtractError }
