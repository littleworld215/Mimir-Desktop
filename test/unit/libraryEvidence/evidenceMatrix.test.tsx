// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EvidenceMatrix } from '../../../src/components/modules/library/evidence/EvidenceMatrix'
import { EvidenceExportDialog } from '../../../src/components/modules/library/evidence/EvidenceExportDialog'
afterEach(cleanup)
it('恢复矩阵完整筛选并夹紧过期页码，全部范围不冒充当前项目', async () => {
  const scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
  const list = vi.fn().mockImplementation(request => Promise.resolve({ ok: true, scope, revision: 1, rows: [], total: 1, page: request.page, pageSize: 50 }))
  window.electronAPI = { libraryEvidence: { list } } as never
  render(<EvidenceMatrix projectId="project" papers={[]} projects={[]} initialBrowseState={{ filter: { archive: 'include', source: 'problem', keyword: '旧关键词' }, page: 5, scrollTop: 20 }} />)
  await waitFor(() => expect(screen.getByText(/第 1 页/)).toBeTruthy())
  await waitFor(() => expect(list.mock.calls.filter(([request]) => request.scope)).toHaveLength(2))
  expect((screen.getByLabelText('比较范围') as HTMLSelectElement).value).toBe('all')
  const scopedCalls = list.mock.calls.map(([request]) => request).filter(request => request.scope)
  expect(scopedCalls.map(request => request.page)).toEqual([5, 1])
  expect(scopedCalls.every(request => request.filter.keyword === '旧关键词' && request.filter.projectId === undefined)).toBe(true)
})
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
