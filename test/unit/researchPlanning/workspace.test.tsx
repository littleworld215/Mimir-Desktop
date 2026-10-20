// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchPlanning } from '../../../src/components/modules/planning/ResearchPlanning'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

afterEach(cleanup)
const state = { revision: 0, scope: { workspaceId: 's', spaceEpoch: 'e' } }
function api() {
  const defaults = emptyPlanningDocument()
  return { bootstrap: vi.fn().mockResolvedValue({ ok: true, ...state, total: 0, types: defaults.types, collections: defaults.collections }), list: vi.fn().mockResolvedValue({ ok: true, ...state, items: [], total: 0, page: 1, pageSize: 50 }), save: vi.fn().mockResolvedValue({ ok: false, code: 'WRITE_FAILED', message: '磁盘失败，输入保留' }), mutate: vi.fn() }
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
