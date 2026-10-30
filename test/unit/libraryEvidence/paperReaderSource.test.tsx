// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PaperReader } from '../../../src/components/modules/library/PaperReader'
import type { PdfExcerpt } from '../../../src/lib/pdfReaderTypes'
const scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
let emitOld: ((excerpt: PdfExcerpt) => void) | undefined
vi.mock('../../../src/components/modules/library/EnhancedPdfReader', () => ({ EnhancedPdfReader: (props: any) => {
  emitOld = props.onExcerpt
  return <div data-testid="enhanced-source">{props.paperId}|{props.url}</div>
} }))
vi.mock('../../../src/components/modules/library/evidence/EvidencePanel', () => ({
  evidenceSourceLabels: { unbound: '未绑定' },
  EvidencePanel: (props: any) => <><button onClick={() => props.onOpenSource({ status: 'unbound', locationMode: 'manual-page', pdfUrl: 'mimir-pdf://paper/paper-b.pdf#page=2' })}>打开另一篇来源</button><output data-testid="accepted-excerpt">{props.excerpt?.quote}</output></>
}))
vi.mock('../../../src/components/modules/library/usePaperRecoveryDraft', () => ({ usePaperRecoveryDraft: () => ({ existing: [], status: 'idle' }) }))
const props = { scope, paper: { arxivId: 'paper-a', title: '文献A', authors: [], notes: '', pdfPath: 'synthetic.pdf', url: 'https://example.invalid' } as any, onClose: vi.fn(), onUpdateNotes: vi.fn(), onOpenExternal: vi.fn(), initialTab: 'evidence' as const }
afterEach(() => { cleanup(); emitOld = undefined })
it('另一篇来源仍可原生查看，但不能以原文献身份增强摘录；显式返回后才恢复', async () => {
  render(<PaperReader {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '增强阅读', exact: true }))
  expect((await screen.findByTestId('enhanced-source')).textContent).toBe('paper-a|mimir-pdf://paper/paper-a.pdf')
  fireEvent.click(screen.getByRole('button', { name: '打开另一篇来源' }))
  expect(screen.queryByTestId('enhanced-source')).toBeNull()
  expect((screen.getByTitle('文献A') as HTMLIFrameElement).src).toBe('mimir-pdf://paper/paper-b.pdf#page=2')
  expect((screen.getByRole('button', { name: '增强阅读', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '返回当前文献PDF', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '增强阅读', exact: true }))
  expect((await screen.findByTestId('enhanced-source')).textContent).toBe('paper-a|mimir-pdf://paper/paper-a.pdf')
})
it('换源前的迟到选区不得进入原文献新卡，返回后仍拒绝旧代际回调', async () => {
  render(<PaperReader {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '增强阅读', exact: true }))
  await screen.findByTestId('enhanced-source')
  const stale = emitOld!
  fireEvent.click(screen.getByRole('button', { name: '打开另一篇来源' }))
  const excerpt: PdfExcerpt = { id: 'late', scope, paperId: 'paper-a', renderId: 'old', page: 2, quote: '迟到正文' }
  await act(async () => stale(excerpt))
  expect(screen.getByTestId('accepted-excerpt').textContent).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '返回当前文献PDF', exact: true }))
  await act(async () => stale(excerpt))
  expect(screen.getByTestId('accepted-excerpt').textContent).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '增强阅读', exact: true }))
  await screen.findByTestId('enhanced-source')
  await act(async () => emitOld!({ ...excerpt, id: 'current', quote: '当前正文' }))
  expect(screen.getByTestId('accepted-excerpt').textContent).toBe('当前正文')
})
