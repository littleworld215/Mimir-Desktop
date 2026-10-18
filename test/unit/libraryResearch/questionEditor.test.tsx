// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QuestionEditor } from '../../../src/components/modules/library/research/QuestionEditor'
import { hasEvidenceWork, requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'
import { uiFixtures, uiScope } from './uiFixtures'
afterEach(cleanup)
it('问题冲突保留多行空白，保存成功才清脏；复用现有离开守卫', async () => {
  const { questionReply } = uiFixtures()
  const save = vi.fn().mockResolvedValueOnce({ ok: false, code: 'CONFLICT', message: '并发变化，输入保留' }).mockResolvedValue({ ok: true, ...questionReply })
  render(<QuestionEditor scope={uiScope} projectId="project-1" initial={questionReply.question.versions[0]} revision={3} evidenceRevision={1} save={save} />)
  const input = screen.getByLabelText('具体研究问题') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '  问题😀\n\n' } })
  await act(async () => { expect(await requestEvidenceLeave('save')).toBe(false) })
  expect(input.value).toBe('  问题😀\n\n'); expect(hasEvidenceWork()).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '保存问题' }))
  await waitFor(() => expect(hasEvidenceWork()).toBe(false))
  expect(save.mock.calls[1]![0].question).toBe('  问题😀\n\n')
})
it('父操作忙时不能改写或丢弃，输入法CtrlEnter不保存', async () => {
  const { questionReply } = uiFixtures(), save = vi.fn().mockResolvedValue({ ok: true, ...questionReply })
  const props = { scope: uiScope, projectId: 'project-1', initial: questionReply.question.versions[0], revision: 3, evidenceRevision: 1, save }
  const view = render(<QuestionEditor {...props} externalBusy />)
  expect((screen.getByLabelText('问题标题') as HTMLInputElement).disabled).toBe(true)
  expect(await requestEvidenceLeave('discard')).toBe(false)
  view.rerender(<QuestionEditor {...props} externalBusy={false} />)
  const input = screen.getByLabelText('具体研究问题')
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 })
  expect(save).not.toHaveBeenCalled()
})
