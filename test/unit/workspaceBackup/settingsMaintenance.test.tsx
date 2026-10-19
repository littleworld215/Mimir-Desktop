// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsBackupCard } from '../../../src/components/modules/settings/SettingsBackup'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function bridge(enterMaintenance = vi.fn().mockResolvedValue({ ok: true })) {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { workspaceBackup: { enterMaintenance } } })
  return enterMaintenance
}
it('旧安装桥缺失时解释升级，不触发窗口关闭', () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })
  render(<SettingsBackupCard />)
  expect((screen.getByRole('button', { name: '备份与恢复' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/当前版本未提供维护入口/)).toBeTruthy()
})
it('未保存设置禁止进入，确认取消不发请求', () => {
  const enter = bridge(), view = render(<SettingsBackupCard disabledReason="请先保存设置" />)
  expect((screen.getByRole('button', { name: '备份与恢复' }) as HTMLButtonElement).disabled).toBe(true)
  view.rerender(<SettingsBackupCard />)
  fireEvent.click(screen.getByRole('button', { name: '备份与恢复' }))
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(enter).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('显式确认只发一次无参数请求，请求不冒充已备份', async () => {
  let finish!: (value: { ok: true }) => void
  const enter = bridge(vi.fn(() => new Promise(resolve => { finish = resolve })))
  render(<SettingsBackupCard />)
  fireEvent.click(screen.getByRole('button', { name: '备份与恢复' }))
  const confirm = screen.getByRole('button', { name: '关闭工作台并进入维护' })
  fireEvent.click(confirm); fireEvent.click(confirm)
  expect(enter).toHaveBeenCalledTimes(1)
  expect(enter).toHaveBeenCalledWith()
  finish({ ok: true })
  await screen.findByText(/已请求进入维护/)
  expect(screen.queryByText(/备份成功/)).toBeNull()
})
it('请求失败保留弹窗并可重试，错误不泄露路径或密钥', async () => {
  const enter = bridge(vi.fn().mockRejectedValueOnce(Error('private-secret C:/private/data')).mockResolvedValue({ ok: true }))
  render(<SettingsBackupCard />)
  fireEvent.click(screen.getByRole('button', { name: '备份与恢复' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭工作台并进入维护' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).not.toContain('private')
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '关闭工作台并进入维护' }))
  await waitFor(() => expect(enter).toHaveBeenCalledTimes(2))
})
it('确认期间出现未保存状态时仍不能发起交接', () => {
  const enter = bridge(), view = render(<SettingsBackupCard />)
  fireEvent.click(screen.getByRole('button', { name: '备份与恢复' }))
  view.rerender(<SettingsBackupCard disabledReason="请先保存设置" />)
  fireEvent.click(screen.getByRole('button', { name: '关闭工作台并进入维护' }))
  expect(enter).not.toHaveBeenCalled()
})
