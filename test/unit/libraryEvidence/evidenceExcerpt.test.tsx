// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EvidencePanel } from '../../../src/components/modules/library/evidence/EvidencePanel'
import { EvidenceEditor, evidenceFields } from '../../../src/components/modules/library/evidence/EvidenceEditor'
import { registerEvidenceEditor, hasEvidenceWork } from '../../../src/lib/evidenceEditGuard'
import type { PdfExcerpt } from '../../../src/lib/pdfReaderTypes'
import { EvidenceLeaveDialog } from '../../../src/components/modules/library/evidence/EvidenceLeaveDialog'
import { version } from './fixtures'
const scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
const excerpt: PdfExcerpt = { id: 'excerpt-1', scope, paperId: 'paper', renderId: 'render', page: 3, quote: '  原文😀\n\n' }
function api() {
  const api = { list: vi.fn().mockResolvedValue({ ok: true, scope, revision: 0, rows: [], total: 0, page: 1, pageSize: 50 }), create: vi.fn().mockResolvedValue({ ok: false, code: 'WRITE_FAILED', message: '合成失败，保留输入' }), checkSource: vi.fn() }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { libraryEvidence: api } }); return api
}
afterEach(cleanup)
it('接收只生成一个未保存新卡；不调用核对，保存失败输入保留', async () => {
  const bridge = api(), accepted = vi.fn()
  const view = render(<EvidencePanel paperId="paper" projectId="project" scope={scope} onOpenSource={() => {}} {...{ excerpt, onExcerptAccepted: accepted }} />)
  const input = await screen.findByLabelText('原文摘录') as HTMLTextAreaElement
  expect(input.value).toBe(excerpt.quote)
  expect((screen.getByLabelText('PDF物理起始页') as HTMLInputElement).value).toBe('3')
  expect(hasEvidenceWork()).toBe(true)
  expect(bridge.create).not.toHaveBeenCalled(); expect(bridge.checkSource).not.toHaveBeenCalled()
  view.rerender(<EvidencePanel paperId="paper" projectId="project" scope={scope} onOpenSource={() => {}} {...{ excerpt, onExcerptAccepted: accepted }} />)
  expect(accepted).toHaveBeenCalledTimes(1)
  expect(screen.getAllByLabelText('原文摘录')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '保存证据' }))
  await waitFor(() => expect(bridge.create).toHaveBeenCalledOnce())
  expect(bridge.create.mock.calls[0]![0]).toMatchObject({ scope, input: { quote: excerpt.quote, projectIds: ['project'], locator: { pageStart: 3, pageEnd: 3 } } })
  expect(input.value).toBe(excerpt.quote)
})
it('取消原守卫保留原输入与待接收候选，显式重试后才接收', async () => {
  api()
  let busy = true
  const remove = registerEvidenceEditor({ isDirty: () => false, isBusy: () => busy, save: async () => false, discard: () => {} })
  try {
    render(<EvidencePanel paperId="paper" scope={scope} onOpenSource={() => {}} {...{ excerpt }} />)
    await screen.findByRole('button', { name: '接收PDF摘录为新卡' })
    expect(screen.queryByLabelText('原文摘录')).toBeNull()
    busy = false
    fireEvent.click(screen.getByRole('button', { name: '接收PDF摘录为新卡' }))
    await screen.findByLabelText('原文摘录')
  } finally { remove() }
})
it('同文献ID不同scope不接受候选，也不写入', async () => {
  const bridge = api(), accepted = vi.fn()
  render(<EvidencePanel paperId="paper" scope={scope} onOpenSource={() => {}} {...{ excerpt: { ...excerpt, scope: { ...scope, spaceEpoch: 'old' } }, onExcerptAccepted: accepted }} />)
  await screen.findByText(/摘录所属空间或文献已变化/)
  expect(screen.queryByLabelText('原文摘录')).toBeNull()
  expect(accepted).not.toHaveBeenCalled(); expect(bridge.create).not.toHaveBeenCalled()
})
it('初始摘录按新草稿标脏，旧卡initial优先且不从模板继承核对状态', () => {
  const fields = { ...evidenceFields('paper', []), quote: excerpt.quote, locator: { pageStart: 3, pageEnd: 3 } }
  render(<EvidenceEditor paperId="paper" projectIds={[]} revision={0} save={vi.fn()} {...{ initialFields: fields }} />)
  expect((screen.getByLabelText('原文摘录') as HTMLTextAreaElement).value).toBe(excerpt.quote)
  expect(hasEvidenceWork()).toBe(true)
})
it('真实取消对话同时保留原有编辑与待接收摘录，丢弃后才替换', async () => {
  const bridge = api()
  const tree = (pending?: PdfExcerpt) => <><EvidenceLeaveDialog /><EvidencePanel paperId="paper" scope={scope} onOpenSource={() => {}} {...{ excerpt: pending }} /></>
  const view = render(tree())
  await waitFor(() => expect((screen.getByRole('button', { name: '新建证据卡' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '新建证据卡' }))
  const original = await screen.findByLabelText('原文摘录') as HTMLTextAreaElement
  fireEvent.change(original, { target: { value: '原有未保存输入' } })
  view.rerender(tree(excerpt))
  await screen.findByRole('dialog', { name: '存在未保存的研究资料编辑' })
  fireEvent.click(screen.getByRole('button', { name: '留在这里' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(original.value).toBe('原有未保存输入')
  fireEvent.click(screen.getByRole('button', { name: '接收PDF摘录为新卡' }))
  await screen.findByRole('dialog', { name: '存在未保存的研究资料编辑' })
  fireEvent.click(screen.getByRole('button', { name: '丢弃后离开' }))
  await waitFor(() => expect((screen.getByLabelText('原文摘录') as HTMLTextAreaElement).value).toBe(excerpt.quote))
  expect(bridge.create).not.toHaveBeenCalled()
})
it('编辑既有版本时initialFields不能覆盖原文，也不使原版本变脏', () => {
  render(<EvidenceEditor paperId="paper" projectIds={[]} revision={1} initial={version()} save={vi.fn()} initialFields={{ ...evidenceFields('paper', []), quote: '不应使用此摘录' }} />)
  expect((screen.getByLabelText('原文摘录') as HTMLTextAreaElement).value).toBe(version().quote)
  expect(hasEvidenceWork()).toBe(false)
})
