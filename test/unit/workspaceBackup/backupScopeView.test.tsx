// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackupScopeView } from '../../../src/components/maintenance/BackupScopeView'
import { BackupArchiveDetails } from '../../../src/components/maintenance/BackupArchiveDetails'
import type { MaintenanceArchiveDetailsResult, WorkspaceBackupMaintenanceApi } from '../../../shared/workspaceBackupContracts'

afterEach(cleanup)
const summary = { metadata: 'present' as const, coverage: 'known-structured-fields' as const, excludedCount: 1, externalCount: 1, unresolvedCount: 0 }
it('范围与内容校验分开，旧包说明未知，不渲染未请求的外部路径', () => {
  const view = render(<BackupScopeView scope={summary} verification="not-run" />)
  expect(screen.getByText(/内容校验尚未运行/)).toBeTruthy()
  expect(screen.getByText(/未纳入超限项：1/)).toBeTruthy()
  expect(screen.getByText(/已知外部引用：1/)).toBeTruthy()
  view.rerender(<BackupScopeView verification="passed" />)
  expect(screen.getByText(/已纳入内容校验通过/)).toBeTruthy()
  expect(screen.getByText(/该备份未保存范围说明/)).toBeTruthy()
})

it('A说明迟到不能覆盖B；显示的归档文字转义且关闭恢复焦点', async () => {
  const button = document.createElement('button'); document.body.append(button); button.focus()
  let finishA!: (result: MaintenanceArchiveDetailsResult) => void
  const api: WorkspaceBackupMaintenanceApi = { overview: vi.fn(), archiveDetails: vi.fn(({ archiveId }) => archiveId === 'A'
    ? new Promise(resolve => { finishA = resolve }) : Promise.resolve({ ok: true, verification: 'not-run', page: { summary, offset: 0, items: [{ kind: 'external', entry: { storeKey: 'library:papers', locator: '[0]', field: 'pdfPath', kind: 'pdf', status: 'not-included-unchecked', target: '<script>window.SYNTHETIC=true</script>B' } }] } })) }
  const close = vi.fn(), view = render(<BackupArchiveDetails api={api} archiveId="A" onClose={close} />)
  view.rerender(<BackupArchiveDetails api={api} archiveId="B" onClose={close} />)
  await waitFor(() => expect(screen.getByText(/<script>window.SYNTHETIC=true<\/script>B/)).toBeTruthy())
  await act(async () => { finishA({ ok: true, verification: 'not-run', page: { summary, offset: 0, items: [{ kind: 'excluded', entry: { path: 'OLD-A', size: 2, reason: 'oversize', defaultDisposition: 'exclude' } }] } }) })
  expect(screen.queryByText(/OLD-A/)).toBeNull()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
  view.unmount(); expect(document.activeElement).toBe(button); button.remove()
})

it('旧桥缺说明API时解释无法展开，不回退为任意路径读取', async () => {
  render(<BackupArchiveDetails api={{ overview: vi.fn() }} archiveId="id" onClose={() => {}} />)
  expect(await screen.findByText(/当前主进程不支持展开归档说明/)).toBeTruthy()
})

it('桥同步抛错时保留说明窗口和可重试反馈', async () => {
  render(<BackupArchiveDetails api={{ overview: vi.fn(), archiveDetails: () => { throw new Error('synthetic disconnected bridge') } }} archiveId="id" onClose={() => {}} />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('button', { name: '重试读取' })).toBeTruthy()
})
