// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlanningEditor } from '../../../src/components/modules/planning/PlanningEditor'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'
import { hasEvidenceWork, requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'

afterEach(cleanup)
it('明确保留草稿并返回只持久化草稿，成功后才允许离开，不正式保存或清理草稿', async () => {
  const defaults = emptyPlanningDocument(), scope = { workspaceId: 's', spaceEpoch: 'e' }, save = vi.fn(), onCancel = vi.fn(), removeDraft = vi.fn()
  const saveDraft = vi.fn().mockResolvedValue({ ok: true, scope, revision: 1 })
  window.electronAPI = { researchPlanning: { drafts: vi.fn().mockResolvedValue({ ok: true, scope, revision: 0, drafts: [] }), saveDraft, removeDraft } } as unknown as typeof window.electronAPI
  render(<PlanningEditor initial={emptyPlanningInput('generic')} scope={scope} types={defaults.types} collections={defaults.collections} save={save} onSaved={vi.fn()} onCancel={onCancel} />)
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: ' \n待续内容\n' } })
  fireEvent.click(screen.getByRole('button', { name: '保留草稿并返回' }))
  await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  expect(saveDraft).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled(); expect(removeDraft).not.toHaveBeenCalled()
  expect(hasEvidenceWork()).toBe(false)
})
it('文献计划保留作者、年份、DOI、URL和阅读状态，不自动读取PDF', async () => {
  const save = vi.fn().mockResolvedValue(undefined), defaults = emptyPlanningDocument()
  render(<PlanningEditor initial={emptyPlanningInput('literature')} types={defaults.types} collections={defaults.collections} save={save} onSaved={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '待读文献' } })
  fireEvent.change(screen.getByLabelText('作者（每行一位）'), { target: { value: '甲\n乙' } })
  fireEvent.change(screen.getByLabelText('发表年份'), { target: { value: '2026' } })
  fireEvent.change(screen.getByLabelText('DOI'), { target: { value: '10.1000/example' } })
  fireEvent.change(screen.getByLabelText('文献URL'), { target: { value: 'https://example.test/paper' } })
  fireEvent.change(screen.getByLabelText('阅读状态'), { target: { value: 'reading' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]![0].literature).toEqual({ authors: ['甲', '乙'], year: 2026, doi: '10.1000/example', url: 'https://example.test/paper', readingState: 'reading', paperId: null })
})
it('编辑暂停后保存恢复草稿，自动保存不冒充正式保存；失败保留输入', async () => {
  const defaults = emptyPlanningDocument(), scope = { workspaceId: 's', spaceEpoch: 'e' }
  const saveDraft = vi.fn().mockResolvedValue({ ok: false, code: 'WRITE_FAILED', message: '恢复草稿磁盘失败' }), save = vi.fn()
  window.electronAPI = { researchPlanning: { drafts: vi.fn().mockResolvedValue({ ok: true, scope, revision: 0, drafts: [] }), saveDraft, removeDraft: vi.fn() } } as unknown as typeof window.electronAPI
  render(<PlanningEditor initial={emptyPlanningInput('generic')} scope={scope} types={defaults.types} collections={defaults.collections} save={save} onSaved={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '\n  未命名草稿\n' } })
  await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce(), { timeout: 2000 })
  expect(saveDraft.mock.calls[0]![0]).toMatchObject({ scope, expectedRevision: 0, draft: { itemId: null, baseRevision: 0, input: { title: '', content: '\n  未命名草稿\n' } } })
  expect(await screen.findByText(/恢复草稿磁盘失败/)).toBeTruthy()
  expect(screen.getByLabelText('正文')).toHaveProperty('value', '\n  未命名草稿\n')
  expect(save).not.toHaveBeenCalled(); expect(hasEvidenceWork()).toBe(true)
})
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
