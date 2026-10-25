// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { join } from 'node:path'
import type { WorkspaceBackupMaintenanceApi } from '../../../shared/workspaceBackupContracts'
afterEach(cleanup)
const id = '11111111-1111-4111-8111-111111111111'
async function subject() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'src/components/maintenance/RestoreRecoveryPanel.tsx')).catch(() => ({}))
  expect(mod.RestoreRecoveryPanel).toBeTypeOf('function')
  return mod.RestoreRecoveryPanel
}
const list = (name = '合成空间', writable = true) => ({ ok: true as const, writable, invalidRecords: 0, truncated: false, items: [{ operationId: id, spaceName: name, createdAt: '2026-10-25', phase: 'published', status: 'pending-registration' as const, entries: 2, totalBytes: 8, actions: ['register' as const] }] })
it('登记动作只带ID与固定动作，并在完成后刷新', async () => {
  const Panel = await subject(), action = vi.fn(async () => ({ ok: true, operationId: id, action: 'register' })), changed = vi.fn()
  const api = { recoveryList: vi.fn(async () => list()), recoveryAction: action } as unknown as WorkspaceBackupMaintenanceApi
  render(<Panel api={api} refreshVersion={0} onChanged={changed} />)
  fireEvent.click(await screen.findByRole('button', { name: '复核并完成登记' }))
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operationId: id, action: 'register' }))
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
})
it('锁阻断时显示只读说明并禁用写按钮', async () => {
  const Panel = await subject(), api = { recoveryList: async () => list('合成空间', false) } as WorkspaceBackupMaintenanceApi
  render(<Panel api={api} refreshVersion={0} />)
  await screen.findByText(/只读/)
  expect((await screen.findByRole('button', { name: '复核并完成登记' }) as HTMLButtonElement).disabled).toBe(true)
})
it('读取失败不能显示成没有中断任务，支持重新读取', async () => {
  const Panel = await subject(), read = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(list())
  render(<Panel api={{ recoveryList: read } as unknown as WorkspaceBackupMaintenanceApi} refreshVersion={0} />)
  await screen.findByRole('alert')
  expect(screen.queryByText('没有恢复操作记录。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新读取恢复记录' }))
  await screen.findByText('合成空间')
})
it('刷新后迟到的旧列表不能盖掉新记录', async () => {
  const Panel = await subject()
  let old!: (value: ReturnType<typeof list>) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { old = resolve })).mockResolvedValue(list('最新记录'))
  const api = { recoveryList: read } as unknown as WorkspaceBackupMaintenanceApi
  const view = render(<Panel api={api} refreshVersion={0} />)
  view.rerender(<Panel api={api} refreshVersion={1} />)
  await screen.findByText('最新记录')
  await act(async () => old(list('迟到旧记录')))
  expect(screen.queryByText('迟到旧记录')).toBeNull()
})
it('旧桥缺少恢复入口时显示降级提示', async () => {
  const Panel = await subject()
  render(<Panel api={{} as WorkspaceBackupMaintenanceApi} refreshVersion={0} />)
  await screen.findByText(/尚未提供/)
})

it('损坏记录不能同时被显示成没有操作记录', async () => {
  const Panel = await subject()
  const api = { recoveryList: async () => ({ ...list(), items: [], invalidRecords: 1 }) } as unknown as WorkspaceBackupMaintenanceApi
  render(<Panel api={api} refreshVersion={0} />)
  await screen.findByText(/有 1 份记录无法安全读取/)
  expect(screen.queryByText('没有恢复操作记录。')).toBeNull()
})

it('下一页能找到旧待登记任务，返回首页不丢失入口', async () => {
  const Panel = await subject(), cursor = '22222222-2222-4222-8222-222222222222'
  const read = vi.fn(async (next?: string) => next ? list('旧待登记任务') : { ...list(), items: [], truncated: true, nextCursor: cursor })
  render(<Panel api={{ recoveryList: read } as unknown as WorkspaceBackupMaintenanceApi} refreshVersion={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '下一页恢复记录' }))
  await screen.findByText('旧待登记任务')
  expect(read).toHaveBeenLastCalledWith(cursor)
  fireEvent.click(screen.getByRole('button', { name: '返回恢复记录首页' }))
  await waitFor(() => expect(read).toHaveBeenLastCalledWith(undefined))
})
