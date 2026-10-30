import type { PdfExcerpt } from './pdfReaderTypes'

/** DOM identity is a UI freshness check; the existing main-process source guards remain authoritative. */
export function capturePdfExcerpt(root: HTMLElement, identity: Omit<PdfExcerpt, 'id' | 'quote'>, selection: Selection | null): PdfExcerpt | undefined {
  if (!root.isConnected || !selection || selection.rangeCount !== 1 || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode) || !root.contains(selection.getRangeAt(0).commonAncestorContainer)) return
  if (root.dataset.pdfPaperId !== identity.paperId || root.dataset.workspaceId !== identity.scope.workspaceId || root.dataset.spaceEpoch !== identity.scope.spaceEpoch || root.dataset.renderId !== identity.renderId || root.dataset.pdfPage !== String(identity.page) || !Number.isSafeInteger(identity.page) || identity.page < 1) return
  const quote = selection.toString()
  if (!quote.trim()) return
  if (Array.from(quote).length > 20000) { const error = Error('摘录超过20000码点；请缩小选区，原选区未截断。'); error.name = 'PDF_SELECTION_LIMIT'; throw error }
  return { ...identity, scope: { ...identity.scope }, quote, id: crypto.randomUUID() }
}
