// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MaintenanceTaskControls } from '../../../src/components/maintenance/MaintenanceTaskControls'
import { TaskProgressGuard } from '../../../src/components/maintenance/taskProgress'
import type { WorkspaceBackupMaintenanceApi } from '../../../shared/workspaceBackupContracts'

afterEach(cleanup)
const id = '38f7433d-612b-4e86-8472-efb1ba44e9c9', other = '76aa7272-4d3f-4b40-a32f-195bf43999ec'
const progress = { taskId: id, stage: 'packing', detail: '合成', cancellable: true }
const api = (cancelTask = vi.fn(async () => ({ ok: true }))) => ({ cancelTask, overview: vi.fn() }) as unknown as WorkspaceBackupMaintenanceApi
it('cancels only the shown ID and shows request rather than fabricated completion', async () => {
  const cancel = vi.fn(async () => ({ ok: true }))
  render(<MaintenanceTaskControls api={api(cancel)} progress={progress} label="取消备份" />)
  fireEvent.click(screen.getByRole('button', { name: '取消备份' }))
  await screen.findByText('已请求取消，正在等待安全点和资源收尾。')
  expect(cancel).toHaveBeenCalledWith({ taskId: id })
  expect(screen.getByRole('button', { name: '取消备份' }).hasAttribute('disabled')).toBe(true)
})
it('late cancellation replies cannot overwrite the next task notice', async () => {
  let resolve!: (v: { ok: boolean }) => void
  const cancel = vi.fn(() => new Promise<{ ok: boolean }>(r => { resolve = r }))
  const view = render(<MaintenanceTaskControls api={api(cancel)} progress={progress} label="取消任务" />)
  fireEvent.click(screen.getByRole('button', { name: '取消任务' }))
  view.rerender(<MaintenanceTaskControls api={api(cancel)} progress={{ ...progress, taskId: other }} label="取消任务" />)
  resolve({ ok: true })
  await waitFor(() => expect(screen.queryByText('已请求取消，正在等待安全点和资源收尾。')).toBeNull())
  expect(screen.getByRole('button', { name: '取消任务' }).hasAttribute('disabled')).toBe(false)
})
it('commit state disables cancellation and explains why', () => {
  render(<MaintenanceTaskControls api={api()} progress={{ ...progress, cancellable: false }} label="取消恢复" />)
  expect(screen.getByRole('button', { name: '取消恢复' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('已进入提交阶段，无法安全取消。')).toBeTruthy()
})
it('guard ignores anonymous, wrong-kind, old-generation and retired task progress', () => {
  const guard = new TaskProgressGuard()
  const first = guard.begin('backup')
  expect(guard.accept('doctor', progress)).toBe(false)
  expect(guard.accept('backup', { stage: 'packing' })).toBe(false)
  expect(guard.accept('backup', { ...progress, stage: 'starting' })).toBe(true)
  expect(guard.accept('backup', { ...progress, taskId: other })).toBe(false)
  guard.end(first)
  const next = guard.begin('backup')
  expect(guard.accept('backup', { ...progress, stage: 'starting' })).toBe(false)
  expect(guard.accept('backup', { ...progress, taskId: other, stage: 'starting' })).toBe(true)
  guard.end(first)
  expect(guard.accept('backup', { ...progress, taskId: other })).toBe(true)
  guard.end(next)
  expect(guard.accept('backup', { ...progress, taskId: other })).toBe(false)
})
