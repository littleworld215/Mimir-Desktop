import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as implementation from '../../../src/lib/pdfReaderDocument'

const api = implementation as unknown as Record<string, (...args: any[]) => any>
function method(name: string) { expect(api[name], name).toBeTypeOf('function'); return api[name]! }
afterEach(() => { vi.restoreAllMocks() })
const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: { workerSrc: '' } }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdf)
beforeEach(() => { pdf.getDocument.mockReset() })

it('128MiB精确边界合法，超限/非有限/非整数计数拒绝', () => {
  const budget = method('checkPdfByteBudget')
  expect(() => budget(128 * 1024 * 1024)).not.toThrow()
  for (const bytes of [128 * 1024 * 1024 + 1, -1, NaN, Infinity, 1.5]) expect(() => budget(bytes)).toThrow()
})

it('未知长度按实际流合并字节，输出独立副本且正常结束释放锁', async () => {
  const first = new Uint8Array([37, 80]), second = new Uint8Array([68, 70, 45])
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(first); c.enqueue(second); c.close() } })
  const result = await method('collectReaderPdfBytes')(stream, new AbortController().signal)
  expect([...result]).toEqual([37, 80, 68, 70, 45])
  first[0] = 0; expect(result[0]).toBe(37)
  expect(stream.locked).toBe(false)
})

it('超限实际流在交付解析前拒绝，并等待cancel结束再释放锁', async () => {
  let cancelFinished = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(128 * 1024 * 1024 + 1)) },
    async cancel() { await Promise.resolve(); cancelFinished = true }
  })
  await expect(method('collectReaderPdfBytes')(stream, new AbortController().signal)).rejects.toMatchObject({ code: 'PDF_LIMIT' })
  expect(cancelFinished).toBe(true)
  expect(stream.locked).toBe(false)
})

it('取消正在等待读取时先完成实际cancel，不能把空流当成功', async () => {
  const controller = new AbortController(), cancel = vi.fn(async () => { await Promise.resolve() })
  const stream = new ReadableStream<Uint8Array>({ cancel })
  const loading = method('collectReaderPdfBytes')(stream, controller.signal)
  controller.abort()
  await expect(loading).rejects.toMatchObject({ code: 'PDF_CANCELED' })
  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
})

it('已取消请求不消费内容；原始流错误与清理失败都不可伪装为成功', async () => {
  const controller = new AbortController(); controller.abort()
  const cancel = vi.fn(async () => {})
  const canceled = new ReadableStream<Uint8Array>({ cancel })
  await expect(method('collectReaderPdfBytes')(canceled, controller.signal)).rejects.toMatchObject({ code: 'PDF_CANCELED' })
  expect(cancel).toHaveBeenCalledOnce()
  const bad = new ReadableStream<Uint8Array>({ start(c) { c.error(Error('synthetic read failure')) } })
  await expect(method('collectReaderPdfBytes')(bad, new AbortController().signal)).rejects.toBeTruthy()
  expect(bad.locked).toBe(false)
})

it('cancel拒绝被显式报告并释放锁，不产生未处理拒绝', async () => {
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({ cancel: async () => { throw Error('synthetic cleanup failure') } })
  const loading = method('collectReaderPdfBytes')(stream, controller.signal)
  controller.abort()
  await expect(loading).rejects.toMatchObject({ code: 'PDF_CLEANUP_FAILED' })
  expect(stream.locked).toBe(false)
})

it('Canvas实际像素不超过1600万，非法尺寸/比例不分配', () => {
  const size = method('readerCanvasSize')
  for (const [width, height, ratio] of [[595, 842, 2], [10000, 10000, 4], [30000, 10, 4]]) {
    const result = size(width, height, ratio)
    expect(result.width * result.height).toBeLessThanOrEqual(16000000)
    expect(result.width).toBeLessThanOrEqual(32767)
    expect(result.height).toBeLessThanOrEqual(32767)
    expect(result.ratioX).toBeGreaterThan(0)
  }
  for (const args of [[0, 1, 1], [1, 0, 1], [NaN, 1, 1], [1, 1, 0], [1, 1, Infinity], [Infinity, 1, 1]]) expect(() => size(...args)).toThrow()
})

it('仅规范受管地址可读取，外部/路径/查询/片段在fetch前拒绝', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  for (const url of ['https://example.invalid/p.pdf', 'file:///p.pdf', 'mimir-pdf://wrong/p.pdf', 'mimir-pdf://paper/a/b.pdf', 'mimir-pdf://paper/a.pdf?x=1', 'mimir-pdf://paper/a.pdf#page=2', 'mimir-pdf://paper/%61.pdf']) {
    await expect(method('loadReaderPdf')({ url, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PDF_READ_FAILED' })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('读取实际流后才本地解析，禁用外部附加资源，dispose只销毁一次且等待完成', async () => {
  const doc = { numPages: 1 }, destroy = vi.fn(async () => {})
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve(doc), destroy })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70, 45]), { headers: { 'content-length': '1' } }))
  const handle = await method('loadReaderPdf')({ url: 'mimir-pdf://paper/p.pdf', signal: new AbortController().signal })
  expect(handle.document).toBe(doc)
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
  expect(pdf.getDocument.mock.calls[0]![0]).toMatchObject({ data: new Uint8Array([37, 80, 68, 70, 45]), enableXfa: false, useWorkerFetch: false, useWasm: false })
  expect(pdf.getDocument.mock.calls[0]![0]).not.toHaveProperty('url')
  await Promise.all([handle.dispose(), handle.dispose()])
  expect(destroy).toHaveBeenCalledOnce()
})

it('谎报小长度不能绕过实流预算；大长度提前取消，不启动解析', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  for (const headers of [{ 'content-length': '1' }, { 'content-length': String(128 * 1024 * 1024 + 1) }]) {
    const cancel = vi.fn(async () => {})
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(128 * 1024 * 1024 + 1)) }, cancel }), { headers }))
    await expect(method('loadReaderPdf')({ url: 'mimir-pdf://paper/p.pdf', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PDF_LIMIT' })
    expect(cancel).toHaveBeenCalledOnce()
  }
  expect(pdf.getDocument).not.toHaveBeenCalled()
})

it('取消解析等待实际destroy结束；迟到解析不能返回句柄', async () => {
  const controller = new AbortController()
  let parsed!: (value: unknown) => void, finishDestroy!: () => void
  const destroy = vi.fn(() => new Promise<void>(resolve => { finishDestroy = resolve }))
  pdf.getDocument.mockReturnValue({ promise: new Promise(resolve => { parsed = resolve }), destroy })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70, 45])))
  let settled = false
  const loading = method('loadReaderPdf')({ url: 'mimir-pdf://paper/p.pdf', signal: controller.signal }).finally(() => { settled = true })
  await vi.waitFor(() => expect(pdf.getDocument).toHaveBeenCalledOnce())
  controller.abort()
  await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  parsed({ numPages: 1 }); finishDestroy()
  await expect(loading).rejects.toMatchObject({ code: 'PDF_CANCELED' })
  expect(destroy).toHaveBeenCalledOnce()
})

it('解析失败仍销毁；销毁失败显式报告且不显示成功', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array([37, 80, 68, 70, 45])))
  const destroy = vi.fn(async () => {})
  pdf.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject(Error('synthetic parse failure')), destroy }))
  await expect(method('loadReaderPdf')({ url: 'mimir-pdf://paper/p.pdf', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PDF_READ_FAILED' })
  expect(destroy).toHaveBeenCalledOnce()
  pdf.getDocument.mockReturnValueOnce({ promise: Promise.resolve({ numPages: 1 }), destroy: async () => { throw Error('synthetic destroy failure') } })
  const handle = await method('loadReaderPdf')({ url: 'mimir-pdf://paper/p.pdf', signal: new AbortController().signal })
  await expect(handle.dispose()).rejects.toMatchObject({ code: 'PDF_CLEANUP_FAILED' })
})
