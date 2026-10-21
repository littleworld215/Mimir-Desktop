// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { followPlanningNotice } from '../../../src/lib/planningNoticeNavigation'
import { allowSettingsLeave, registerSettingsSession } from '../../../src/lib/settingsGuard'
import { consumePlanningIntent, rememberPlanningIntent } from '../../../src/lib/planningNavigation'

afterEach(() => { registerSettingsSession(null); sessionStorage.clear() })
const scope = { workspaceId: 'space', spaceEpoch: 'generation' }
it('通知只有在当前空间代际一致并通过离开保护后才成为一次性详情意图', async () => {
  const bootstrap = vi.fn(async () => ({ ok: true as const, scope })), canLeave = vi.fn(async () => true), open = vi.fn(rememberPlanningIntent)
  expect(await followPlanningNotice({ scope, itemId: 'todo-id' }, { bootstrap, canLeave, open })).toBe(true)
  expect(consumePlanningIntent()).toMatchObject({ workspaceId: scope.workspaceId, spaceEpoch: scope.spaceEpoch, itemId: 'todo-id', kind: 'todo' })
  expect(consumePlanningIntent()).toBeNull(); expect(canLeave).toHaveBeenCalledOnce()
})
it('旧代际、任意路径、取消以及等待保存期间切换空间均不消费输入或跳转', async () => {
  const bootstrap = vi.fn(async () => ({ ok: true as const, scope })), canLeave = vi.fn(async () => false), open = vi.fn()
  expect(await followPlanningNotice({ scope: { ...scope, spaceEpoch: 'old' }, itemId: 'id' }, { bootstrap, canLeave, open })).toBe(false)
  expect(await followPlanningNotice({ scope, itemId: 'file:///secret' }, { bootstrap, canLeave, open })).toBe(false)
  expect(await followPlanningNotice({ scope, itemId: 'id' }, { bootstrap, canLeave, open })).toBe(false)
  canLeave.mockResolvedValue(true); bootstrap.mockResolvedValueOnce({ ok: true, scope }).mockResolvedValueOnce({ ok: true, scope: { ...scope, spaceEpoch: 'new' } })
  expect(await followPlanningNotice({ scope, itemId: 'id' }, { bootstrap, canLeave, open })).toBe(false)
  expect(open).not.toHaveBeenCalled()
})
it('设置保存失败或仍脏时阻止离开，确认取消不保存', async () => {
  let dirty = true
  const save = vi.fn(async () => {})
  registerSettingsSession({ isDirty: () => dirty, save })
  expect(await allowSettingsLeave(() => false)).toBe(false); expect(save).not.toHaveBeenCalled()
  expect(await allowSettingsLeave(() => true)).toBe(false)
  save.mockImplementation(async () => { throw Error('disk') }); expect(await allowSettingsLeave(() => true)).toBe(false)
  save.mockImplementation(async () => { dirty = false }); expect(await allowSettingsLeave(() => true)).toBe(true)
})
