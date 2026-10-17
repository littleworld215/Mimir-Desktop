// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EvidenceMatrix } from '../../../src/components/modules/library/evidence/EvidenceMatrix'
import { EvidenceExportDialog } from '../../../src/components/modules/library/evidence/EvidenceExportDialog'
afterEach(cleanup)
it('矩阵丢弃迟到初始响应；导出预览采用主进程全范围计数', async () => {
  const pending: ((value: unknown) => void)[] = []
  const list = vi.fn(() => new Promise(resolve => pending.push(resolve)))
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { libraryEvidence: { list, export: vi.fn().mockResolvedValue({ ok: true, cardCount: 120, versionCount: 240, saved: false }) } } })
  const view = render(<EvidenceMatrix projectId="old" papers={[]} projects={[]} />)
  await waitFor(() => expect(pending.length).toBe(1))
  view.rerender(<EvidenceMatrix projectId="new" papers={[]} projects={[]} />)
  await waitFor(() => expect(pending.length).toBe(2))
  await act(async () => { pending[0]!({ ok: true, scope: { workspaceId: 'old', spaceEpoch: 'old' }, revision: 99, rows: [], total: 100, page: 1, pageSize: 50 }) })
  expect(list).toHaveBeenCalledTimes(2); view.unmount()
  render(<EvidenceExportDialog scope={{ workspaceId: 'space', spaceEpoch: 'epoch' }} revision={1} filter={{ archive: 'exclude', source: 'all' }} onClose={() => {}} />)
  await screen.findByText(/120 张证据卡/)
  expect(screen.getByText('JSON固定包含选中卡片的全部历史；首版不提供导入覆盖。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
})
