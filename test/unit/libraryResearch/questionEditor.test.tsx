// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QuestionEditor } from '../../../src/components/modules/library/research/QuestionEditor'
import { hasEvidenceWork, requestEvidenceLeave, setEvidenceLeaveChooser } from '../../../src/lib/evidenceEditGuard'
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
  expect(document.activeElement).toBe(screen.getByRole('alert'))
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

it('Esc经统一守卫，取消保留脏输入；确认丢弃才关闭且输入法Esc不离开', async () => {
  const { questionReply } = uiFixtures(), onCancel = vi.fn(), save = vi.fn()
  const remove = setEvidenceLeaveChooser(async () => 'cancel')
  const view = render(<QuestionEditor scope={uiScope} projectId="project-1" initial={questionReply.question.versions[0]} revision={3} evidenceRevision={1} save={save} onCancel={onCancel} />)
  try {
    const title = screen.getByLabelText('问题标题') as HTMLTextAreaElement
    fireEvent.change(title, { target: { value: '未保存问题' } })
    fireEvent.keyDown(title, { key: 'Escape' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(title.value).toBe('未保存问题'); expect(onCancel).not.toHaveBeenCalled()
    remove()
    const allow = setEvidenceLeaveChooser(async () => 'discard')
    try {
      fireEvent.keyDown(title, { key: 'Escape', isComposing: true, keyCode: 229 })
      await new Promise(resolve => setTimeout(resolve, 0)); expect(onCancel).not.toHaveBeenCalled()
      fireEvent.keyDown(title, { key: 'Escape' })
      await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
    } finally { allow() }
  } finally { remove(); view.unmount() }
})