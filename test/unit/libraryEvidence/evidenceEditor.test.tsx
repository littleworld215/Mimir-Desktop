// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EvidenceEditor } from '../../../src/components/modules/library/evidence/EvidenceEditor'
import { hasEvidenceWork, requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'
import { fields, document as evidenceDocument, version } from './fixtures'
afterEach(cleanup)
it('摘录空白和emoji完整保留，失败/冲突不清脏，成功才清除', async () => {
  const card = evidenceDocument().cards[0]!
  const save = vi.fn().mockResolvedValueOnce({ ok: false, code: 'CONFLICT', message: '保留输入并重新加载' }).mockImplementation(async input => ({ ok: true, revision: 2, card: { ...card, versions: [{ ...version(), ...input }] } }))
  render(<EvidenceEditor paperId={fields().paperId} projectIds={fields().projectIds} initial={version()} revision={1} save={save} />)
  const input = screen.getByLabelText('原文摘录') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '  原文😀\n\n' } })
  expect(hasEvidenceWork()).toBe(true)
  expect(await requestEvidenceLeave('save')).toBe(false)
  expect(input.value).toBe('  原文😀\n\n')
  expect(hasEvidenceWork()).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '保存证据' }))
  await waitFor(() => expect(hasEvidenceWork()).toBe(false))
  expect(save.mock.calls[1]![0].quote).toBe('  原文😀\n\n')
})
it('输入法组合Enter不提交，普通换行保留；重复保存与卸载后迟到返回不影响新页', async () => {
  let finish!: (value: unknown) => void
  const save = vi.fn(() => new Promise(resolve => { finish = resolve })), saved = vi.fn()
  const view = render(<EvidenceEditor paperId={fields().paperId} projectIds={[]} initial={version()} revision={1} save={save as never} onSaved={saved} />)
  const input = screen.getByLabelText('原文摘录')
  fireEvent.change(input, { target: { value: 'changed' } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(save).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  fireEvent.click(screen.getByRole('button', { name: /保存/ }))
  expect(save).toHaveBeenCalledTimes(1)
  expect(await requestEvidenceLeave('discard')).toBe(false)
  view.unmount(); finish({ ok: true, revision: 2, card: evidenceDocument().cards[0] })
  await new Promise(resolve => setTimeout(resolve, 0)); expect(saved).not.toHaveBeenCalled()
})
