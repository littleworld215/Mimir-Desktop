// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchPlanning } from '../../../src/components/modules/planning/ResearchPlanning'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'
import { hasEvidenceWork, requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'
import { rememberPlanningIntent } from '../../../src/lib/planningNavigation'

afterEach(cleanup)
it('当前代际通知直接打开不在当前页的待办，旧代际通知不读取详情', async () => {
  const planning = api(), item = { ...emptyPlanningInput('todo'), id: 'not-on-page', title: '通知指定的待办', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }
  const detail = vi.fn().mockResolvedValue({ ok: true, ...state, item })
  window.electronAPI = { researchPlanning: { ...planning, detail } } as unknown as typeof window.electronAPI
  rememberPlanningIntent({ workspaceId: state.scope.workspaceId, spaceEpoch: state.scope.spaceEpoch, kind: 'todo', todoView: 'all', itemId: item.id })
  const view = render(<ResearchPlanning />)
  expect(await screen.findByLabelText('标题')).toHaveProperty('value', item.title)
  expect(detail).toHaveBeenCalledWith({ scope: state.scope, itemId: item.id })
  view.unmount(); detail.mockClear()
  rememberPlanningIntent({ workspaceId: state.scope.workspaceId, spaceEpoch: 'old', kind: 'todo', itemId: item.id })
  render(<ResearchPlanning />)
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新列表' })).toHaveProperty('disabled', false))
  expect(detail).not.toHaveBeenCalled()
})
it('科研项目筛选不能使用会清理其他项目的整组已完成按钮', async () => {
  const planning = api(), item = { ...emptyPlanningInput('project'), id: 'project-filter', title: '限定课题', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }
  planning.list.mockImplementation(async request => ({ ok: true, ...state, items: request.filter.kind === 'project' ? [item] : [], total: request.filter.kind === 'project' ? 1 : 0, page: 1, pageSize: 50 }))
  window.electronAPI = { researchPlanning: planning } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  await screen.findByRole('button', { name: '限定课题', exact: true })
  fireEvent.click(screen.getByRole('button', { name: '待办', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: '按科研项目筛选', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: '限定课题', exact: true }))
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新列表' })).toHaveProperty('disabled', false))
  expect(screen.getByRole('button', { name: '当前分组/类型已完成移入回收站' })).toHaveProperty('disabled', true)
})
it('列表标题支持方向键和Home/End定位，输入框不被抢走焦点', async () => {
  const planning = api()
  const items = ['第一条项目', '第二条项目'].map((title, index) => ({ ...emptyPlanningInput('project'), id: `p${index}`, title, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }))
  planning.list.mockResolvedValue({ ok: true, ...state, items, total: 2, page: 1, pageSize: 50 })
  window.electronAPI = { researchPlanning: planning } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  const first = await screen.findByRole('button', { name: '第一条项目', exact: true }), second = screen.getByRole('button', { name: '第二条项目', exact: true })
  first.focus(); fireEvent.keyDown(first, { key: 'ArrowDown' }); expect(document.activeElement).toBe(second)
  fireEvent.keyDown(second, { key: 'Home' }); expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'End' }); expect(document.activeElement).toBe(second)
  const search = screen.getByLabelText('搜索科研计划'); search.focus(); fireEvent.keyDown(search, { key: 'ArrowDown' }); expect(document.activeElement).toBe(search)
})
it('恢复草稿先完整核对，明确采用当前修订后保存仍更新原记录', async () => {
  const planning = api(), defaults = emptyPlanningDocument(), input = { ...emptyPlanningInput('generic'), title: '恢复内容', content: '\n  草稿原文\n' }
  const draft = { id: 'draft-session', itemId: 'record', baseRevision: 0, input, updatedAt: '2026-10-21T00:00:00.000Z' }
  planning.bootstrap.mockResolvedValue({ ok: true, ...state, revision: 2, total: 0, types: defaults.types, collections: defaults.collections })
  planning.list.mockResolvedValue({ ok: true, ...state, revision: 2, items: [], total: 0, page: 1, pageSize: 50 })
  planning.summary.mockResolvedValue({ ok: true, ...state, revision: 2, nextActions: {} })
  const detail = vi.fn().mockResolvedValue({ ok: true, ...state, revision: 2, item: { ...input, id: 'record', title: '当前正式内容', content: '当前原文' } })
  const drafts = vi.fn().mockResolvedValue({ ok: true, ...state, revision: 1, drafts: [draft] })
  window.electronAPI = { researchPlanning: { ...planning, detail, drafts, saveDraft: vi.fn(), removeDraft: vi.fn().mockResolvedValue({ ok: true, ...state, revision: 2 }) } } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  fireEvent.click(await screen.findByRole('button', { name: '恢复编辑恢复内容' }))
  expect(await screen.findByRole('dialog', { name: '核对恢复草稿' })).toBeTruthy()
  expect(screen.getByText('当前原文')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '已核对，采用当前修订继续编辑', exact: true }))
  expect(screen.getByLabelText('正文')).toHaveProperty('value', '\n  草稿原文\n')
  fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
  await waitFor(() => expect(planning.save).toHaveBeenCalledOnce())
  expect(planning.save.mock.calls[0]![0]).toMatchObject({ expectedRevision: 2, itemId: 'record', input: { title: '恢复内容' } })
})
const state = { revision: 0, scope: { workspaceId: 's', spaceEpoch: 'e' } }
function api() {
  const defaults = emptyPlanningDocument()
  return { bootstrap: vi.fn().mockResolvedValue({ ok: true, ...state, total: 0, types: defaults.types, collections: defaults.collections }), list: vi.fn().mockResolvedValue({ ok: true, ...state, items: [], total: 0, page: 1, pageSize: 50 }), summary: vi.fn().mockResolvedValue({ ok: true, ...state, counts: { myDay: 0, overdue: 0, weekEvents: 0, activeProjects: 0 }, myDay: [], overdue: [], weekEvents: [], activeProjects: [], nextActions: {} }), save: vi.fn().mockResolvedValue({ ok: false, code: 'WRITE_FAILED', message: '磁盘失败，输入保留' }), mutate: vi.fn() }
}
it('启动失败可重试；列表请求不发送空scope，空库不注入示例', async () => {
  const planning = api(); planning.bootstrap.mockRejectedValueOnce(Error('连接中断'))
  window.electronAPI = { researchPlanning: planning } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '连接中断')
  expect(planning.list).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试加载' }))
  expect(await screen.findByText('当前没有匹配的科研计划。')).toBeTruthy()
  expect(planning.list.mock.calls[0]![0].scope).toEqual(state.scope)
})
it('新建方向保存失败保留输入，当前基线修订不会随列表变化被替换', async () => {
  const planning = api()
  window.electronAPI = { researchPlanning: planning } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  await screen.findByText('当前没有匹配的科研计划。')
  fireEvent.click(screen.getByRole('button', { name: '科研方向' }))
  await waitFor(() => expect(planning.list).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: '新建科研方向' }))
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '主攻方向' } })
  fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '磁盘失败，输入保留')
  expect(screen.getByLabelText('标题')).toHaveProperty('value', '主攻方向')
  expect(planning.save.mock.calls[0]![0]).toMatchObject({ scope: state.scope, expectedRevision: 0, input: { ...emptyPlanningInput('direction'), title: '主攻方向' } })
})
it('分组被迁移删除后清除失效筛选，不持续向接口发送已删除分组', async () => {
  const planning = api(), defaults = emptyPlanningDocument(), group = { id: 'group', name: '课题分组', order: 1, deleted: false }
  planning.bootstrap.mockResolvedValue({ ok: true, ...state, total: 0, types: defaults.types, collections: [...defaults.collections, group] })
  window.electronAPI = { researchPlanning: planning } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  await screen.findByText('当前没有匹配的科研计划。')
  fireEvent.change(screen.getByLabelText('筛选分组'), { target: { value: 'group' } })
  await waitFor(() => expect(planning.list).toHaveBeenCalledTimes(2))
  planning.bootstrap.mockResolvedValue({ ok: true, ...state, total: 0, types: defaults.types, collections: defaults.collections })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
  await waitFor(() => expect(planning.list.mock.calls.at(-1)![0].filter.collectionId).toBeUndefined())
})
it('跨日刷新不卸载脏表单，即使下一次读取会失败也保留输入', async () => {
  const planning = api()
  window.electronAPI = { researchPlanning: planning } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  await screen.findByText('当前没有匹配的科研计划。')
  fireEvent.click(screen.getByRole('button', { name: '新建科研项目' }))
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '不能丢失的项目输入' } })
  planning.bootstrap.mockRejectedValue(Error('后台读取失败'))
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await act(async () => { vi.setSystemTime(new Date('2099-01-01T09:00:00')); window.dispatchEvent(new Event('focus')); await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(screen.getByLabelText('标题')).toHaveProperty('value', '不能丢失的项目输入')
    expect(planning.bootstrap).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})
it('快速添加尚未提交的文字也受离开守卫保护，失败保留、明确丢弃才清除', async () => {
  const planning = api()
  window.electronAPI = { researchPlanning: planning } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  await screen.findByText('当前没有匹配的科研计划。')
  fireEvent.click(screen.getByRole('button', { name: '待办', exact: true }))
  await waitFor(() => expect(planning.list).toHaveBeenCalledTimes(2))
  fireEvent.change(screen.getByLabelText('快速添加待办'), { target: { value: '不能丢失的快速输入' } })
  expect(hasEvidenceWork()).toBe(true)
  await act(async () => { expect(await requestEvidenceLeave('save')).toBe(false) })
  expect(screen.getByLabelText('快速添加待办')).toHaveProperty('value', '不能丢失的快速输入')
  await act(async () => { expect(await requestEvidenceLeave('discard')).toBe(true) })
  expect(screen.getByLabelText('快速添加待办')).toHaveProperty('value', '')
})
