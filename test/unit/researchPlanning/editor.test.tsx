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
it('待办独立填写我的一天、截止日、优先级及周期规则，保存保留各字段', async () => {
  const save = vi.fn().mockResolvedValue(undefined), defaults = emptyPlanningDocument()
  render(<PlanningEditor initial={emptyPlanningInput('todo')} types={defaults.types} collections={defaults.collections} save={save} onSaved={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '阅读计划' } })
  fireEvent.change(screen.getByLabelText('截止日期'), { target: { value: '2026-10-23' } })
  fireEvent.change(screen.getByLabelText('我的一天日期'), { target: { value: '2026-10-20' } })
  fireEvent.change(screen.getByLabelText('优先级'), { target: { value: 'high' } })
  fireEvent.change(screen.getByLabelText('重复规则'), { target: { value: 'weekly' } })
  fireEvent.change(screen.getByLabelText('重复间隔'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]![0]).toMatchObject({ myDay: '2026-10-20', dueDate: '2026-10-23', priority: 'high', recurrence: { unit: 'weekly', interval: 2 } })
})
it('已有计划关联显示可读名称及归档状态，不把内部标识当用户文案', async () => {
  const defaults = emptyPlanningDocument()
  window.electronAPI = { researchPlanning: { detail: vi.fn().mockResolvedValue({ ok: true, item: { title: '可读项目名称', archived: true, deleted: false } }) } } as unknown as typeof window.electronAPI
  render(<PlanningEditor initial={{ ...emptyPlanningInput('todo'), projectId: 'internal-project' }} scope={{ workspaceId: 's', spaceEpoch: 'e' }} types={defaults.types} collections={defaults.collections} save={vi.fn()} onSaved={vi.fn()} onCancel={vi.fn()} />)
  expect(await screen.findByText('可读项目名称（已归档）')).toBeTruthy()
  expect(screen.queryByText('internal-project')).toBeNull()
})
