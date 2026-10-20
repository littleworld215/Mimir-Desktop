// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlanningEditor } from '../../../src/components/modules/planning/PlanningEditor'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'
import { hasEvidenceWork, requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'

afterEach(cleanup)
it('保存失败保留标题与多行正文并聚焦反馈；重试成功后才清除未保存状态', async () => {
  const saved = vi.fn().mockRejectedValueOnce(Error('已有更新，请保留输入')).mockResolvedValue(undefined), closed = vi.fn(), defaults = emptyPlanningDocument()
  render(<PlanningEditor initial={emptyPlanningInput('project')} types={defaults.types} collections={defaults.collections} save={saved} onSaved={closed} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '  科研项目  ' } })
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '\n  内容\n\n' } })
  await act(async () => { expect(await requestEvidenceLeave('save')).toBe(false) })
  expect(screen.getByLabelText('正文')).toHaveProperty('value', '\n  内容\n\n')
  expect(document.activeElement).toBe(screen.getByRole('alert'))
  expect(hasEvidenceWork()).toBe(true); expect(closed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
  await waitFor(() => expect(closed).toHaveBeenCalledOnce())
  expect(saved.mock.calls[1]![0]).toMatchObject({ title: '  科研项目  ', content: '\n  内容\n\n' })
})
it('输入法CtrlEnter不保存；自定义字段可保留空值，分栏预览不执行HTML', async () => {
  const save = vi.fn(), defaults = emptyPlanningDocument()
  render(<PlanningEditor initial={emptyPlanningInput('generic')} types={defaults.types} collections={defaults.collections} save={save} onSaved={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.keyDown(screen.getByLabelText('正文'), { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 })
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '添加字段' }))
  expect(screen.getByLabelText('字段1值')).toHaveProperty('value', '')
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '<img src="https://example.test/pixel">\n\n# 标题' } })
  fireEvent.click(screen.getByRole('button', { name: '分栏预览' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy())
  expect(document.querySelector('img')).toBeNull()
})
