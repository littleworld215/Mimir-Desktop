// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import * as implementation from '../../../src/lib/pdfSelection'
import type { PdfExcerpt } from '../../../src/lib/pdfReaderTypes'
const capture = (root: HTMLElement, identity: Omit<PdfExcerpt, 'id' | 'quote'>, selection: Selection | null) => {
  const method = (implementation as unknown as { capturePdfExcerpt?: (...args: any[]) => PdfExcerpt | undefined }).capturePdfExcerpt
  expect(method).toBeTypeOf('function'); return method!(root, identity, selection)
}
const identity = { scope: { workspaceId: 'space', spaceEpoch: 'epoch' }, paperId: 'paper', renderId: 'render', page: 2 }
function setup(text: string) {
  const root = document.createElement('div')
  Object.assign(root.dataset, { pdfPaperId: 'paper', workspaceId: 'space', spaceEpoch: 'epoch', renderId: 'render', pdfPage: '2' })
  root.textContent = text; document.body.append(root)
  const range = document.createRange(); range.selectNodeContents(root)
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  return { root, selection }
}
afterEach(() => { document.body.replaceChildren(); document.getSelection()?.removeAllRanges() })
it('仅当前页原样捕获空白Unicode，多行及反向选择一致', () => {
  const quote = '  原文😀\n\n保持空白  ', { root, selection } = setup(quote)
  expect(capture(root, identity, selection)?.quote).toBe(quote)
  selection.setBaseAndExtent(root.firstChild!, quote.length, root.firstChild!, 0)
  expect(capture(root, identity, selection)).toMatchObject({ ...identity, quote })
})
it('侧栏/跨区域、旧render、跨scope、脱离页面和空选区拒绝', () => {
  const { root, selection } = setup('原文')
  const other = document.createTextNode('侧栏'); document.body.append(other)
  selection.setBaseAndExtent(root.firstChild!, 0, other, 1)
  expect(capture(root, identity, selection)).toBeUndefined()
  selection.selectAllChildren(root)
  expect(capture(root, { ...identity, renderId: 'old' }, selection)).toBeUndefined()
  expect(capture(root, { ...identity, scope: { ...identity.scope, spaceEpoch: 'other' } }, selection)).toBeUndefined()
  root.remove(); expect(capture(root, identity, selection)).toBeUndefined()
  expect(capture(root, identity, null)).toBeUndefined()
})
it('两万码点精确边界合法，超过不截断、不改写选区', () => {
  const { root, selection } = setup('😀'.repeat(20000))
  expect(capture(root, identity, selection)?.quote).toBe('😀'.repeat(20000))
  root.textContent = '😀'.repeat(20001); selection.selectAllChildren(root)
  expect(() => capture(root, identity, selection)).toThrow(/20000/)
  expect(selection.toString()).toBe('😀'.repeat(20001))
})
