import { useEffect, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { loadReaderPdf, readerCanvasSize, type ReaderPdfHandle } from '@/lib/pdfReaderDocument'
import type { EvidenceScope } from '../../../../shared/libraryEvidenceContracts'
import type { PdfExcerpt } from '@/lib/pdfReaderTypes'
import { capturePdfExcerpt } from '@/lib/pdfSelection'
import './enhancedPdfReader.css'

export interface EnhancedPdfReaderProps {
  scope: EvidenceScope
  paperId: string
  url: string
  initialPage?: number
  initialScale?: number
  onPosition(position: { page: number; scale: number }): void
  onExcerpt?(excerpt: PdfExcerpt): void
}
const scales = [0.5, 0.75, 1, 1.25, 1.5, 2]

/** Single-page canvas and text share one viewport; detached renders cannot publish after invalidation. */
export function EnhancedPdfReader(props: EnhancedPdfReaderProps) {
  const { scope, paperId, url } = props
  const identity = JSON.stringify([scope.workspaceId, scope.spaceEpoch, paperId, url])
  const latest = useRef(props); latest.current = props
  const [attempt, setAttempt] = useState(0), [active, setActive] = useState<{ identity: string; handle: ReaderPdfHandle }>()
  const [page, setPage] = useState(1), [pageInput, setPageInput] = useState('1'), [scale, setScale] = useState(1)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [noText, setNoText] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const [candidate, setCandidate] = useState<{ excerpt: PdfExcerpt; range: Range }>(), [selectionError, setSelectionError] = useState('')
  const submitted = useRef('')
  const submittedSelection = useRef<{ excerpt: PdfExcerpt; range: Range }>()
  useEffect(() => {
    const capture = () => {
      if (!latest.current.onExcerpt) return
      const root = host.current?.querySelector<HTMLElement>('.enhanced-pdf-text[data-render-id]'), selection = document.getSelection()
      if (!root) { setCandidate(undefined); return }
      try {
        const excerpt = capturePdfExcerpt(root, { scope: latest.current.scope, paperId: latest.current.paperId, renderId: root.dataset.renderId!, page: Number(root.dataset.pdfPage) }, selection)
        setSelectionError('')
        if (!excerpt) { setCandidate(undefined); submittedSelection.current = undefined; return }
        const range = selection!.getRangeAt(0).cloneRange()
        const consumed = submittedSelection.current
        if (consumed?.excerpt.renderId === excerpt.renderId && consumed.excerpt.quote === excerpt.quote && consumed.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 && consumed.range.compareBoundaryPoints(Range.END_TO_END, range) === 0) { setCandidate(undefined); return }
        setCandidate(previous => previous?.excerpt.renderId === excerpt.renderId && previous.excerpt.quote === excerpt.quote ? previous : { excerpt, range })
      } catch (failure) { setCandidate(undefined); setSelectionError(failure instanceof Error ? failure.message : '选区不可用，请重新选择。') }
    }
    document.addEventListener('selectionchange', capture)
    document.addEventListener('mouseup', capture)
    document.addEventListener('keyup', capture)
    return () => { document.removeEventListener('selectionchange', capture); document.removeEventListener('mouseup', capture); document.removeEventListener('keyup', capture) }
  }, [identity])
  function submitExcerpt() {
    if (!candidate || submitted.current === candidate.excerpt.id) return
    const { excerpt, range } = candidate, root = host.current?.querySelector<HTMLElement>('.enhanced-pdf-text[data-render-id]')
    if (!root?.isConnected || root.dataset.renderId !== excerpt.renderId || !root.contains(range.commonAncestorContainer) || range.toString() !== excerpt.quote || excerpt.scope.workspaceId !== scope.workspaceId || excerpt.scope.spaceEpoch !== scope.spaceEpoch || excerpt.paperId !== paperId) { setCandidate(undefined); setSelectionError('原选区已失效，请在当前页重新选择。'); return }
    submitted.current = excerpt.id
    submittedSelection.current = candidate
    latest.current.onExcerpt?.(excerpt)
    setCandidate(undefined)
  }
  useEffect(() => {
    let alive = true, loaded: ReaderPdfHandle | undefined
    const controller = new AbortController()
    setActive(undefined); setLoading(true); setError(''); setNoText(false)
    void loadReaderPdf({ url, signal: controller.signal }).then(handle => {
      if (!alive) { void handle.dispose().catch(() => console.warn('[pdf-reader] PDF_CLEANUP_FAILED')); return }
      loaded = handle
      const requested = latest.current.initialPage
      const first = Number.isSafeInteger(requested) && requested! > 0 ? Math.min(requested!, handle.document.numPages) : 1
      setPage(first); setPageInput(String(first)); setScale(scales.includes(latest.current.initialScale!) ? latest.current.initialScale! : 1)
      setActive({ identity, handle })
    }, failure => { if (alive) { setError(failure instanceof Error ? failure.message : 'PDF读取失败，请使用原阅读器。'); setLoading(false) } })
    return () => {
      alive = false; controller.abort()
      if (loaded) void loaded.dispose().catch(() => console.warn('[pdf-reader] PDF_CLEANUP_FAILED'))
    }
  }, [identity, attempt])

  useEffect(() => {
    host.current?.replaceChildren()
    setCandidate(undefined); setSelectionError('')
    if (!active || active.identity !== identity) return
    let alive = true, rendering: RenderTask | undefined, text: TextLayer | undefined, pdfPage: PDFPageProxy | undefined
    const root = host.current
    setLoading(true); setNoText(false); setError('')
    const cancel = () => {
      try { rendering?.cancel(); text?.cancel() } catch { console.warn('[pdf-reader] PDF_CLEANUP_FAILED') }
    }
    void (async () => {
      try {
        pdfPage = await active.handle.document.getPage(page)
        if (!alive) return
        const viewport = pdfPage.getViewport({ scale })
        const raster = readerCanvasSize(viewport.width, viewport.height, window.devicePixelRatio || 1)
        const canvas = document.createElement('canvas'), layer = document.createElement('div'), surface = document.createElement('div')
        canvas.width = raster.width; canvas.height = raster.height
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`
        canvas.setAttribute('aria-label', `PDF物理页 ${page}`)
        surface.className = 'enhanced-pdf-surface'; surface.style.width = `${viewport.width}px`; surface.style.height = `${viewport.height}px`
        surface.style.setProperty('--total-scale-factor', String(viewport.scale))
        surface.style.setProperty('--scale-round-x', '1px'); surface.style.setProperty('--scale-round-y', '1px')
        layer.className = 'enhanced-pdf-text'; layer.setAttribute('aria-label', '当前页文字层')
        const context = canvas.getContext('2d')
        if (!context) throw Error('无法创建PDF画布，请使用原阅读器。')
        const content = await pdfPage.getTextContent()
        if (!alive) return
        rendering = pdfPage.render({ canvasContext: context, canvas, viewport, transform: [raster.ratioX, 0, 0, raster.ratioY, 0, 0], annotationMode: 0 })
        text = new TextLayer({ textContentSource: content, container: layer, viewport })
        const pending = [rendering.promise, text.render()]
        try { await Promise.all(pending) } catch (failure) { cancel(); await Promise.allSettled(pending); throw failure }
        if (!alive || !root?.isConnected) return
        const renderId = crypto.randomUUID()
        surface.dataset.pdfPage = String(page); surface.dataset.renderId = renderId
        Object.assign(layer.dataset, { renderId, pdfPage: String(page), pdfPaperId: paperId, workspaceId: scope.workspaceId, spaceEpoch: scope.spaceEpoch })
        surface.append(canvas, layer); root.replaceChildren(surface)
        setNoText(!content.items.some(item => 'str' in item && item.str.trim().length > 0))
        setLoading(false); latest.current.onPosition({ page, scale })
      } catch (failure) {
        if (alive) { setError(failure instanceof Error ? failure.message : '页面渲染失败，请使用原阅读器。'); setLoading(false) }
      } finally { pdfPage?.cleanup() }
    })()
    return () => { alive = false; cancel(); root?.replaceChildren() }
  }, [active, identity, page, scale])

  const currentDocument = active?.identity === identity ? active.handle.document : undefined
  const move = (next: number) => { if (currentDocument && Number.isSafeInteger(next) && next >= 1 && next <= currentDocument.numPages) { setPage(next); setPageInput(String(next)); setError('') } }
  const applyPage = () => {
    const next = Number(pageInput)
    if (!currentDocument || !Number.isSafeInteger(next) || next < 1 || next > currentDocument.numPages) { setError(`请输入1–${currentDocument?.numPages ?? 1}之间的物理页码。`); return }
    move(next)
  }
  return <section aria-label="增强PDF阅读" className="flex h-full min-h-0 flex-col text-foreground">
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-2 text-xs">
      <button className="rounded border px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring" disabled={!currentDocument || page <= 1} onClick={() => move(page - 1)}>上一页</button>
      <label>PDF物理页 <input aria-label="PDF物理页" className="w-14 rounded border bg-background p-1" inputMode="numeric" disabled={!currentDocument} value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={applyPage} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) applyPage() }} /></label>
      <span>/ {currentDocument?.numPages ?? '—'}</span>
      <button className="rounded border px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring" disabled={!currentDocument || page >= currentDocument.numPages} onClick={() => move(page + 1)}>下一页</button>
      <label>缩放 <select aria-label="PDF缩放" className="rounded border bg-background p-1" disabled={!currentDocument} value={scale} onChange={event => { const value = Number(event.target.value); if (scales.includes(value)) setScale(value) }}>{scales.map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
      {props.onExcerpt && <button className="rounded border px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring" disabled={!candidate || loading} onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={submitExcerpt}>摘录为证据</button>}
    </div>
    {loading && <p role="status" className="p-2 text-sm">正在加载当前物理页…</p>}
    {error && <div className="p-2 text-sm"><p role="alert">{error}</p><button className="rounded border px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setAttempt(value => value + 1)}>重试增强阅读</button></div>}
    {noText && !loading && <p role="status" className="p-2 text-sm">此页没有可用文字层，可能为扫描页；不会自动OCR，可使用原阅读器。</p>}
    {selectionError && <p role="alert" className="p-2 text-sm">{selectionError}</p>}
    <div className="min-h-0 flex-1 overflow-auto p-2" tabIndex={0} aria-label="PDF页面滚动区域"><div ref={host} /></div>
  </section>
}
