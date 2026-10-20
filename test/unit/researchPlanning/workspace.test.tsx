// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchPlanning } from '../../../src/components/modules/planning/ResearchPlanning'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'
import { hasEvidenceWork, requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'

afterEach(cleanup)
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
