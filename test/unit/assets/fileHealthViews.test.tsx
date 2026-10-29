// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { FileHealthReport } from '../../../src/components/modules/assets/FileHealthReport'
import type { FileHealthBatch, FileHealthItem, FileHealthCursor } from '../../../shared/assetsFileHealthContracts'
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }))
vi.mock('../../../src/components/modules/assets/assetsApi', () => ({ assetsApi: { inspectFileHealth: inspect } }))
afterEach(() => { cleanup(); inspect.mockReset() })
const A = { workspaceId: 'A', spaceEpoch: 'A#1' }, B = { workspaceId: 'B', spaceEpoch: 'B#1' }
const item: FileHealthItem = { assetId: 1, assetName: '合成文件', assetCode: 'a1', archived: false, versionId: 1, version: 1, status: 'missing' }
const next: FileHealthCursor = { assetId: 1, versionId: 1, upperAssetId: 2, upperVersionId: 100 }
const batch = (items: FileHealthItem[] = [item], nextCursor: FileHealthCursor | null = null): { batch: FileHealthBatch } => ({ batch: { checkedAt: new Date().toISOString(), digestBaseline: 'not-established', items, nextCursor } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
it('手动开始才调用；无摘要基准，不提供自动修复，失败保留已检查结果', async () => {
  inspect.mockResolvedValueOnce(batch([item], next)).mockRejectedValueOnce(Error('检查失败'))
  render(<FileHealthReport scope={A} onClose={vi.fn()} />)
  expect(inspect).not.toHaveBeenCalled()
  expect(screen.getByText(/摘要基准：未建立/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '开始检查', exact: true }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('检查失败'))
  expect(screen.getByText('合成文件')).toBeTruthy()
  expect(screen.queryByText('检查完成')).toBeNull()
  expect(screen.queryByRole('button', { name: /修复|删除/ })).toBeNull()
})
it('取消后忽略迟到结果、不请求下一批，重检独立开始', async () => {
  const pending = deferred<ReturnType<typeof batch>>()
  inspect.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(batch([]))
  render(<FileHealthReport scope={A} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '开始检查', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '取消检查', exact: true }))
  await act(async () => pending.resolve(batch([item], next)))
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('合成文件')).toBeNull()
  expect(screen.getByText(/已取消/)).toBeTruthy()
  expect(screen.getByText('后续批次已停止；当前批次可能继续完成，其迟到结果不会加入报告。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重新检查', exact: true }))
  await waitFor(() => expect(screen.getByText('检查完成')).toBeTruthy())
  expect(inspect).toHaveBeenLastCalledWith(A)
})
it('空间改变清空旧结果并丢弃在途响应，下次只用新作用域', async () => {
  const pending = deferred<ReturnType<typeof batch>>()
  inspect.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(batch([]))
  const view = render(<FileHealthReport scope={A} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '开始检查', exact: true }))
  view.rerender(<FileHealthReport scope={B} onClose={vi.fn()} />)
  await act(async () => pending.resolve(batch([item], next)))
  expect(screen.queryByText('合成文件')).toBeNull()
  expect(screen.getByText('尚未开始检查。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '开始检查', exact: true }))
  await waitFor(() => expect(screen.getByText('检查完成')).toBeTruthy())
  expect(inspect).toHaveBeenLastCalledWith(B)
})
it('关闭后不再继续批次，不把旧响应写入重开的报告', async () => {
  const pending = deferred<ReturnType<typeof batch>>()
  inspect.mockReturnValueOnce(pending.promise)
  const view = render(<FileHealthReport scope={A} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '开始检查', exact: true }))
  view.unmount()
  await act(async () => pending.resolve(batch([item], next)))
  expect(inspect).toHaveBeenCalledTimes(1)
  render(<FileHealthReport scope={A} onClose={vi.fn()} />)
  expect(screen.getByText('尚未开始检查。')).toBeTruthy()
})
it('大量问题仍只渲染一页，明细保留上限不冒充汇总数', async () => {
  for (let n = 0; n < 11; n++) inspect.mockResolvedValueOnce(batch(
    Array.from({ length: 50 }, (_, index) => ({ ...item, assetId: n * 50 + index + 1, assetName: '文件' + (n * 50 + index + 1) })),
    n === 10 ? null : { ...next, assetId: n + 1 }
  ))
  render(<FileHealthReport scope={A} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '开始检查', exact: true }))
  await waitFor(() => expect(screen.getByText('检查完成')).toBeTruthy(), { timeout: 4000 })
  expect(screen.getByText(/已检查 550/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '问题列表', exact: true }))
  expect(screen.getAllByRole('row')).toHaveLength(51)
  for (let n = 0; n < 9; n++) fireEvent.click(screen.getByRole('button', { name: '下一页', exact: true }))
  expect(screen.getByRole('button', { name: '下一页', exact: true })).toHaveProperty('disabled', true)
  expect(screen.getByText('文件500')).toBeTruthy()
  expect(screen.queryByText('文件501')).toBeNull()
})
