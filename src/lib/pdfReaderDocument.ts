export const READER_PDF_MAX_BYTES = 128 * 1024 * 1024
export const READER_CANVAS_MAX_PIXELS = 16000000

export class PdfReaderError extends Error {
  constructor(readonly code: 'PDF_LIMIT' | 'PDF_CANCELED' | 'PDF_READ_FAILED' | 'PDF_CLEANUP_FAILED' | 'PDF_CANVAS', message: string) {
    super(message)
    this.name = 'PdfReaderError'
  }
}

export function checkPdfByteBudget(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > READER_PDF_MAX_BYTES) {
    throw new PdfReaderError('PDF_LIMIT', '增强阅读最多读取128MiB，请使用原阅读器。')
  }
}

/** Count actual bytes before copying; a length header is never authorization to allocate. */
export async function collectReaderPdfBytes(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  let total = 0, cancellation: Promise<void> | undefined, cancellationFailure: unknown
  const cancel = () => {
    if (!cancellation) cancellation = reader.cancel().catch(failure => { cancellationFailure = failure })
  }
  const assertActive = () => { if (signal.aborted) throw new PdfReaderError('PDF_CANCELED', '已取消PDF读取。') }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    assertActive()
    while (true) {
      const result = await reader.read()
      assertActive()
      if (result.done) break
      if (!(result.value instanceof Uint8Array)) throw new PdfReaderError('PDF_READ_FAILED', 'PDF读取返回了无效字节流。')
      checkPdfByteBudget(total + result.value.byteLength)
      total += result.value.byteLength
      chunks.push(result.value.slice())
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } catch (failure) {
    cancel()
    await cancellation
    if (cancellationFailure && cancellationFailure !== failure) throw new PdfReaderError('PDF_CLEANUP_FAILED', 'PDF读取清理未完成，请关闭增强阅读后重试。')
    if (failure instanceof PdfReaderError) throw failure
    throw new PdfReaderError('PDF_READ_FAILED', 'PDF字节读取失败，请保留当前输入并重试。')
  } finally {
    signal.removeEventListener('abort', cancel)
    if (cancellation) await cancellation
    reader.releaseLock()
  }
}

export function readerCanvasSize(width: number, height: number, pixelRatio: number): { width: number; height: number; ratioX: number; ratioY: number } {
  if (![width, height, pixelRatio].every(value => Number.isFinite(value) && value > 0) || width > 32767 || height > 32767) {
    throw new PdfReaderError('PDF_CANVAS', '此页面尺寸或缩放不适合增强阅读，请减小缩放或使用原阅读器。')
  }
  const ratio = Math.min(pixelRatio, Math.sqrt(READER_CANVAS_MAX_PIXELS / (width * height)), 32767 / width, 32767 / height)
  const canvasWidth = Math.max(1, Math.floor(width * ratio)), canvasHeight = Math.max(1, Math.floor(height * ratio))
  if (canvasWidth * canvasHeight > READER_CANVAS_MAX_PIXELS) throw new PdfReaderError('PDF_CANVAS', '页面超出增强阅读像素预算。')
  return { width: canvasWidth, height: canvasHeight, ratioX: canvasWidth / width, ratioY: canvasHeight / height }
}
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'


export interface ReaderPdfHandle {
  document: PDFDocumentProxy
  dispose(): Promise<void>
}

function assertManagedPdfUrl(raw: string): void {
  try {
    const url = new URL(raw), fileName = url.pathname.slice(1)
    const id = decodeURIComponent(fileName.slice(0, -4))
    if (!id || !fileName.endsWith('.pdf') || id.includes('\0') || fileName.includes('/') || fileName.includes('\\') || raw !== `mimir-pdf://paper/${encodeURIComponent(id)}.pdf`) throw Error('invalid')
  } catch { throw new PdfReaderError('PDF_READ_FAILED', '增强阅读仅接受当前空间的规范受管PDF地址。') }
}

/** Keeps parsing, abort and destruction in one lifetime; only local byte data reaches PDF.js. */
export async function loadReaderPdf({ url, signal }: { url: string; signal: AbortSignal }): Promise<ReaderPdfHandle> {
  assertManagedPdfUrl(url)
  const canceled = () => new PdfReaderError('PDF_CANCELED', '已取消PDF读取。')
  const assertActive = () => { if (signal.aborted) throw canceled() }
  let task: PDFDocumentLoadingTask | undefined, disposal: Promise<void> | undefined
  let onAbort: (() => void) | undefined
  const dispose = (): Promise<void> => {
    if (!disposal) {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      disposal = Promise.resolve().then(() => task?.destroy()).then(() => {}, () => { throw new PdfReaderError('PDF_CLEANUP_FAILED', 'PDF解析资源未能正常释放，请关闭增强阅读后重试。') })
    }
    return disposal
  }
  try {
    assertActive()
    const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' })
    if (!response.ok || !response.body) {
      try { await response.body?.cancel() } catch { throw new PdfReaderError('PDF_CLEANUP_FAILED', 'PDF响应清理未完成。') }
      throw new PdfReaderError('PDF_READ_FAILED', '当前PDF不可读取，可能已移除或来源发生变化。')
    }
    const length = response.headers.get('content-length')
    if (length && /^\d+$/.test(length)) {
      try { checkPdfByteBudget(Number(length)) } catch (failure) {
        try { await response.body.cancel() } catch { throw new PdfReaderError('PDF_CLEANUP_FAILED', '超限PDF响应清理未完成。') }
        throw failure
      }
    }
    const bytes = await collectReaderPdfBytes(response.body, signal)
    assertActive()
    const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')])
    assertActive()
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    task = pdfjs.getDocument({ data: bytes, enableXfa: false, useWorkerFetch: false, useWasm: false, useSystemFonts: true })
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => { void dispose().then(() => reject(canceled()), reject) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const document = await Promise.race([task.promise, abort])
    assertActive()
    return { document, dispose }
  } catch (failure) {
    if (task) await dispose()
    if (failure instanceof PdfReaderError) throw failure
    if (signal.aborted) throw canceled()
    if (failure instanceof Error && failure.name === 'PasswordException') throw new PdfReaderError('PDF_READ_FAILED', '此PDF需要密码，请使用原阅读器或系统阅读器。')
    throw new PdfReaderError('PDF_READ_FAILED', 'PDF读取或解析失败，请使用原阅读器；当前输入已保留。')
  }
}
