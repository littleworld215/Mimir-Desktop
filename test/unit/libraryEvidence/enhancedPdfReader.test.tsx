// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EnhancedPdfReader } from '../../../src/components/modules/library/EnhancedPdfReader'

const fake = vi.hoisted(() => ({ load: vi.fn(), render: vi.fn(), getPage: vi.fn(), texts: [] as { cancel: ReturnType<typeof vi.fn> }[] }))
vi.mock('../../../src/lib/pdfReaderDocument', async original => ({ ...await original<typeof import('../../../src/lib/pdfReaderDocument')>(), loadReaderPdf: fake.load }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ TextLayer: class {
  cancel = vi.fn()
  constructor(private options: { container: HTMLElement }) { fake.texts.push(this) }
  async render() { this.options.container.textContent = 'synthetic page text' }
} }))
const base = { scope: { workspaceId: 'synthetic-space', spaceEpoch: 'epoch-1' }, paperId: 'paper', url: 'mimir-pdf://paper/paper.pdf', onPosition: vi.fn() }
let dispose: ReturnType<typeof vi.fn>, cancelRender: ReturnType<typeof vi.fn>
beforeEach(() => {
  fake.texts = []; fake.getPage.mockReset(); fake.render.mockReset(); fake.load.mockReset(); base.onPosition.mockReset()
  dispose = vi.fn(async () => {}); cancelRender = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never)
  fake.render.mockReturnValue({ promise: Promise.resolve(), cancel: cancelRender })
  fake.getPage.mockImplementation(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }), render: fake.render, getTextContent: async () => ({ items: [{ str: 'synthetic page text' }] }), cleanup: vi.fn() }))
  fake.load.mockResolvedValue({ document: { numPages: 2, getPage: fake.getPage }, dispose })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('当前物理页完成后才呈现文字和记录位置；非法恢复值不进入渲染', async () => {
  render(<EnhancedPdfReader {...base} initialPage={-3} initialScale={Infinity} />)
  await screen.findByText('synthetic page text')
  expect(fake.getPage).toHaveBeenCalledWith(1)
  expect(base.onPosition).toHaveBeenCalledWith({ page: 1, scale: 1 })
  fireEvent.change(screen.getByLabelText('PDF物理页'), { target: { value: '99' } })
  fireEvent.blur(screen.getByLabelText('PDF物理页'))
  expect(fake.getPage).not.toHaveBeenCalledWith(99)
  expect(screen.getByRole('alert').textContent).toContain('1–2')
})

it('翻页使旧渲染取消；迟到旧页不能发布文字层或位置', async () => {
  let finishFirst!: () => void
  fake.render.mockReturnValueOnce({ promise: new Promise<void>(resolve => { finishFirst = resolve }), cancel: cancelRender })
  render(<EnhancedPdfReader {...base} />)
  await waitFor(() => expect(fake.render).toHaveBeenCalledOnce())
  expect(screen.queryByText('synthetic page text')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(base.onPosition).toHaveBeenCalledWith({ page: 2, scale: 1 }))
  finishFirst()
  await Promise.resolve()
  expect(cancelRender).toHaveBeenCalled()
  expect(base.onPosition.mock.calls.map(call => call[0].page)).toEqual([2])
  expect(document.querySelector('[data-pdf-page]')?.getAttribute('data-pdf-page')).toBe('2')
})

it('同ID跨空间使旧加载取消，迟到文档只销毁不显示', async () => {
  let resolveOld!: (value: unknown) => void
  fake.load.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
  const view = render(<EnhancedPdfReader {...base} />)
  await waitFor(() => expect(fake.load).toHaveBeenCalledOnce())
  const oldSignal = fake.load.mock.calls[0]![0].signal as AbortSignal
  view.rerender(<EnhancedPdfReader {...base} scope={{ ...base.scope, spaceEpoch: 'epoch-2' }} />)
  await screen.findByText('synthetic page text')
  const oldDispose = vi.fn(async () => {})
  resolveOld({ document: { numPages: 20, getPage: vi.fn() }, dispose: oldDispose })
  await waitFor(() => expect(oldDispose).toHaveBeenCalledOnce())
  expect(oldSignal.aborted).toBe(true)
  expect(base.onPosition).toHaveBeenCalledTimes(1)
})

it('无文字层明确提示不自动OCR；卸载取消任务并销毁文档', async () => {
  fake.getPage.mockImplementationOnce(async () => ({ getViewport: () => ({ width: 600, height: 800, scale: 1 }), render: fake.render, getTextContent: async () => ({ items: [] }), cleanup: vi.fn() }))
  const view = render(<EnhancedPdfReader {...base} />)
  await screen.findByText(/没有可用文字层/)
  view.unmount()
  await waitFor(() => expect(dispose).toHaveBeenCalledOnce())
})

it('加载失败显示可重试反馈，不假报完成或丢失原阅读入口', async () => {
  fake.load.mockRejectedValueOnce(Error('合成PDF损坏'))
  render(<EnhancedPdfReader {...base} />)
  await screen.findByText('合成PDF损坏')
  expect(base.onPosition).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试增强阅读' }))
  await screen.findByText('synthetic page text')
})

it('重复点击同一未改变选区只发一次，翻页立即使旧候选失效', async () => {
  const excerpt = vi.fn()
  render(<EnhancedPdfReader {...base} onExcerpt={excerpt} />)
  await screen.findByText('synthetic page text')
  const root = document.querySelector<HTMLElement>('.enhanced-pdf-text')!
  const selection = document.getSelection()!; selection.selectAllChildren(root)
  fireEvent(document, new Event('selectionchange'))
  const button = screen.getByRole('button', { name: '摘录为证据' })
  fireEvent.click(button)
  fireEvent.mouseUp(document)
  fireEvent.click(button)
  expect(excerpt).toHaveBeenCalledTimes(1)
  selection.removeAllRanges(); fireEvent(document, new Event('selectionchange'))
  selection.selectAllChildren(root); fireEvent(document, new Event('selectionchange'))
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(base.onPosition).toHaveBeenCalledWith({ page: 2, scale: 1 }))
  expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(excerpt).toHaveBeenCalledTimes(1)
})
