// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsPlanningCard } from '../../../src/components/modules/settings/SettingsPlanning'
import { hasEvidenceWork } from '../../../src/lib/evidenceEditGuard'

afterEach(cleanup)
const scope = { workspaceId: 'synthetic', spaceEpoch: 'generation' }
function api() {
  const state = { preferences: { schemaVersion: 1, revision: 7, tray: false, startup: false, reminders: false }, trayAvailable: true, trayActive: false, startupAvailable: false, startupRegistered: null, notificationsAvailable: true }
  const saveBackground = vi.fn(async () => ({ ok: true, state: { ...state, preferences: { ...state.preferences, revision: 8, reminders: true } } }))
  window.electronAPI = { researchPlanning: { bootstrap: vi.fn(async () => ({ ok: true, scope })), background: vi.fn(async () => ({ ok: true, state })), saveBackground } } as unknown as typeof window.electronAPI
  return saveBackground
}
it('三个开关默认关闭，读取不启用；显式保存带当前空间和偏好修订', async () => {
  const save = api(); render(<SettingsPlanningCard />)
  const reminders = await screen.findByLabelText('运行期间提醒') as HTMLInputElement
  expect(reminders.checked).toBe(false); expect(screen.getByLabelText('关闭窗口后驻留托盘')).toHaveProperty('checked', false)
  expect(screen.getByLabelText('开机启动')).toHaveProperty('disabled', true); expect(save).not.toHaveBeenCalled()
  fireEvent.click(reminders); expect(hasEvidenceWork()).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '保存科研计划后台偏好' }))
  await screen.findByText('后台偏好已保存')
  expect(save).toHaveBeenCalledWith({ scope, expectedRevision: 7, input: { tray: false, startup: false, reminders: true } })
  expect(hasEvidenceWork()).toBe(false)
})
it('失败保留输入和离开保护，修订冲突提示不会自动覆盖', async () => {
  const save = api(); save.mockResolvedValue({ ok: false, message: 'CONFLICT: 其他窗口已更新' } as never)
  render(<SettingsPlanningCard />); fireEvent.click(await screen.findByLabelText('运行期间提醒'))
  fireEvent.click(screen.getByRole('button', { name: '保存科研计划后台偏好' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('其他窗口已更新'))
  expect(screen.getByLabelText('运行期间提醒')).toHaveProperty('checked', true); expect(hasEvidenceWork()).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('alert'))
})
it('保存偏好与本安装原生状态不一致时，无需来回切换也能明确重新应用', async () => {
  const save = api()
  const background = vi.mocked(window.electronAPI!.researchPlanning.background)
  background.mockResolvedValue({ ok: true, state: { preferences: { schemaVersion: 1, revision: 7, tray: false, startup: true, reminders: false }, trayAvailable: true, trayActive: false, startupAvailable: true, startupRegistered: false, notificationsAvailable: true } })
  render(<SettingsPlanningCard />)
  await screen.findByLabelText('开机启动')
  const button = screen.getByRole('button', { name: '保存科研计划后台偏好' })
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await waitFor(() => expect(save).toHaveBeenCalledWith({ scope, expectedRevision: 7, input: { tray: false, startup: true, reminders: false } }))
})
