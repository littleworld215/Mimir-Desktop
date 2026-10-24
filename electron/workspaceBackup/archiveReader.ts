/** 三个读取入口共用生命周期；错误返回前等待实际流与归档句柄收尾。 */
import { createHash } from 'node:crypto'
import { open, close } from 'node:fs'
import type { EventEmitter } from 'node:events'
import { Readable, Transform, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { MANIFEST_IN_ARCHIVE, type ArchiveManifest } from './archiveFormat'
import { ArchiveByteBudget, ArchiveInventory, VerifyError, parseArchiveManifest, resolveArchiveLimits, type ArchiveReadLimits, type ArchiveLimitsInput } from './archivePolicy'
import { readArchiveDirectory, type ArchiveDirectory } from './archiveDirectory'

export interface OpenArchive { zip: yauzl.ZipFile; directory: ArchiveDirectory; close(): Promise<void> }
// 声明文件将游标标为private；仅在锁定3.4.0的此接缝读取，避免交叉类型被推成never。
interface ZipCursor { readEntryCursor: number; entriesRead: number }

export async function openArchive(path: string, input?: ArchiveLimitsInput): Promise<OpenArchive> {
  const limits = resolveArchiveLimits(input)
  return new Promise((resolveOpen, reject) => {
    open(path, 'r', (openError, fd) => {
      if (openError) { reject(new VerifyError('OPEN_FAILED', `无法打开归档：${openError.message}`)); return }
      yauzl.fromFd(fd, { lazyEntries: true, autoClose: false, decodeStrings: true }, (error, zipfile) => {
        if (error || !zipfile) {
          close(fd, closeError => reject(new VerifyError('OPEN_FAILED', `无法打开归档：${closeError?.message ?? error?.message ?? '未知错误'}`)))
          return
        }
        const closed = new Promise<Error | undefined>(resolveClosed => {
          zipfile.once('close', () => resolveClosed(undefined))
          const reader = (zipfile as yauzl.ZipFile & { reader: EventEmitter }).reader
          reader.once('error', error => resolveClosed(error))
        })
        zipfile.on('error', () => {})
        const closeHandle = async () => {
          zipfile.close()
          const closeError = await closed
          if (closeError) throw new VerifyError('READ_FAILED', `关闭归档失败：${closeError.message}`)
        }
        if (!Number.isSafeInteger(zipfile.entryCount) || zipfile.entryCount < 0 || zipfile.entryCount > limits.maxEntries) {
          void closeHandle().then(() => reject(new VerifyError('ENTRY_LIMIT', `归档条目数 ${zipfile.entryCount} 超过上限 ${limits.maxEntries}`)), reject)
        } else {
          void (async () => {
            try {
              const directory = await readArchiveDirectory(fd, zipfile.fileSize)
              if (directory.start !== (zipfile as unknown as ZipCursor).readEntryCursor || directory.count !== zipfile.entryCount) {
                throw new VerifyError('READ_FAILED', 'ZIP中央目录边界或条目计数不符')
              }
              resolveOpen({ zip: zipfile, directory, close: closeHandle })
            } catch (readError) {
              try { await closeHandle() } catch (closeError) { reject(closeError); return }
              reject(readError instanceof VerifyError ? readError : new VerifyError('READ_FAILED', `无法读取归档目录：${(readError as Error).message}`))
            }
          })()
        }
      })
    })
  })
}

/** 一次只消费一个条目；ZIP异步失败时中止在途管线并等待它收尾。 */
export async function walkArchive(handle: OpenArchive, visit: (entry: yauzl.Entry, signal: AbortSignal) => Promise<void>): Promise<void> {
  const zip = handle.zip
  const controller = new AbortController()
  let pending = Promise.resolve()
  let ended = false
  let onEntry: (entry: yauzl.Entry) => void
  let onEnd: () => void
  let onError: (error: Error) => void
  try {
    await new Promise<void>((resolveAll, rejectAll) => {
      const fail = (error: unknown) => { if (!ended) { ended = true; controller.abort(); rejectAll(error) } }
      onEntry = entry => {
        if (ended) return
        pending = Promise.resolve().then(() => visit(entry, controller.signal))
        void pending.then(() => { if (!ended) { try { zip.readEntry() } catch (error) { fail(error) } } }, fail)
      }
      onEnd = () => {
        const cursor = zip as unknown as ZipCursor
        if (cursor.readEntryCursor !== handle.directory.end || cursor.entriesRead !== handle.directory.count) {
          fail(new VerifyError('READ_FAILED', 'ZIP中央目录未完整消费，条目计数或目录范围不符'))
        } else { ended = true; resolveAll() }
      }
      onError = error => fail(new VerifyError('READ_FAILED', `归档读取失败：${error.message}`))
      zip.on('entry', onEntry).on('end', onEnd).on('error', onError)
      try { zip.readEntry() } catch (error) { fail(error) }
    })
  } finally {
    await pending.catch(() => {})
    zip.off('entry', onEntry!).off('end', onEnd!).off('error', onError!)
  }
}

export function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolveStream, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) reject(new VerifyError('READ_FAILED', `无法读取条目：${entry.fileName}（${error?.message ?? '未知错误'}）`))
    else resolveStream(stream)
  }))
}

export function entryCounter(entry: yauzl.Entry, budget: ArchiveByteBudget, consume: (chunk: Buffer) => void): Transform {
  let size = 0
  return new Transform({ transform(chunk: Buffer, _encoding, done) {
    try {
      budget.take(chunk.length)
      size += chunk.length
      if (size > entry.uncompressedSize) throw new VerifyError('SIZE_MISMATCH', `条目字节数不符：${entry.fileName}`)
      consume(chunk)
      done(null, chunk)
    } catch (error) { done(error as Error) }
  }, flush(done) {
    done(size === entry.uncompressedSize ? undefined : new VerifyError('SIZE_MISMATCH', `条目字节数不符：${entry.fileName}`))
  } })
}

/** 区分源读取与目标写入：读取故障保留READ_FAILED，写盘故障由恢复层映射。 */
export async function consumeArchiveEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, budget: ArchiveByteBudget,
  createDestination: () => Writable, consume: (chunk: Buffer) => void, signal: AbortSignal): Promise<void> {
  const source = await entryStream(zip, entry)
  // 源先就绪再创建目标；否则等待openReadStream时写盘错误尚无监听，会成为未处理异常。
  let destination: Writable
  try { destination = createDestination() } catch (error) {
    source.destroy()
    await finished(source).catch(() => {})
    throw error
  }
  const origin: { value?: 'read' | 'write' } = {}
  const readError = () => { origin.value ??= 'read' }
  const writeError = () => { origin.value ??= 'write' }
  source.once('error', readError)
  destination.once('error', writeError)
  try { await pipeline(source, entryCounter(entry, budget, consume), destination, { signal }) } catch (error) {
    if (error instanceof VerifyError || origin.value === 'write') throw error
    throw new VerifyError('READ_FAILED', `读取条目失败：${entry.fileName}（${(error as Error).message}）`)
  } finally { source.off('error', readError); destination.off('error', writeError) }
}

/** 目录也消费实际流；允许合法deflate空流，但任何实际非零内容立即失败。 */
export async function assertEmptyDirectory(zip: yauzl.ZipFile, entry: yauzl.Entry, signal: AbortSignal): Promise<void> {
  await consumeArchiveEntry(zip, entry, new ArchiveByteBudget(0, 'TOTAL_LIMIT'),
    () => new Writable({ write(_chunk, _encoding, done) { done() } }), () => {}, signal)
}

export async function readManifestEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limits: ArchiveReadLimits, signal: AbortSignal): Promise<Buffer> {
  if (entry.uncompressedSize > limits.maxManifestBytes) throw new VerifyError('MANIFEST_LIMIT', '归档清单字节数超过上限')
  const budget = new ArchiveByteBudget(limits.maxManifestBytes, 'MANIFEST_LIMIT')
  const chunks: Buffer[] = []
  await consumeArchiveEntry(zip, entry, budget, () => new Writable({ write(_chunk, _encoding, done) { done() } }), chunk => chunks.push(chunk), signal)
  return Buffer.concat(chunks, budget.total)
}

export interface ArchiveScan {
  manifest: ArchiveManifest
  manifestSha256: string
  inventory: ArchiveInventory
}

/** 预览也扫描完整中央目录，不能在找到首个清单后放过后续重复/超限条目。 */
export async function scanArchive(path: string, limits: ArchiveReadLimits): Promise<ArchiveScan> {
  const handle = await openArchive(path, limits)
  const inventory = new ArchiveInventory(limits)
  let result: { manifest: ArchiveManifest; manifestSha256: string } | undefined
  try {
    await walkArchive(handle, async (entry, signal) => {
      const item = inventory.accept(entry)
      if (item.kind === 'directory') await assertEmptyDirectory(handle.zip, entry, signal)
      if (item.path === MANIFEST_IN_ARCHIVE) {
        const buffer = await readManifestEntry(handle.zip, entry, limits, signal)
        result = { manifest: parseArchiveManifest(buffer, limits), manifestSha256: createHash('sha256').update(buffer).digest('hex') }
      }
    })
  } finally { await handle.close() }
  if (!result) throw new VerifyError('MANIFEST_MISSING', `归档缺少清单 ${MANIFEST_IN_ARCHIVE}`)
  inventory.match(result.manifest)
  return { ...result, inventory }
}

/** 第二遍也读取/限流清单，且不得把前一遍的内容校验当作当前归档的凭据。 */
export async function recheckManifest(zip: yauzl.ZipFile, entry: yauzl.Entry, limits: ArchiveReadLimits, signal: AbortSignal, sha256: string): Promise<void> {
  const buffer = await readManifestEntry(zip, entry, limits, signal)
  if (createHash('sha256').update(buffer).digest('hex') !== sha256) throw new VerifyError('MANIFEST_INVALID', '读取期间归档清单发生变化')
}
