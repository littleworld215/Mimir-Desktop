// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlanningHostLinks } from '../../../src/components/modules/planning/PlanningHostLinks'

afterEach(cleanup)
it('宿主关联按当前空间分页选择；失联显示可读提示，清除不删除原资料', async () => {
  const scope = { workspaceId: 's', spaceEpoch: 'e' }, onChange = vi.fn()
  const references = vi.fn(async (request: { ids?: string[] }) => ({ ok: true, scope, items: request.ids ? [{ id: 'missing', name: '原关联已失联', exists: false }] : [{ id: 'host', name: '可关联文献课题', exists: true }], page: 1, pageSize: 50, total: 1 }))
  window.electronAPI = { researchPlanning: { references } } as unknown as typeof window.electronAPI
  render(<PlanningHostLinks scope={scope} libraryProjectId="missing" experimentIds={[]} onChange={onChange} />)
  expect(await screen.findByText('原关联已失联')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '移除关联原关联已失联' }))
  expect(onChange).toHaveBeenLastCalledWith({ libraryProjectId: null })
  fireEvent.click(screen.getByRole('button', { name: '选择文献项目' }))
  fireEvent.click(await screen.findByRole('button', { name: '可关联文献课题' }))
  expect(onChange).toHaveBeenLastCalledWith({ libraryProjectId: 'host' })
  expect(references.mock.calls.at(-1)![0]).toMatchObject({ scope, kind: 'libraryProject', keyword: '', page: 1 })
  fireEvent.click(screen.getByRole('button', { name: '选择文献项目' }))
  await screen.findByRole('button', { name: '可关联文献课题' })
  fireEvent.keyDown(screen.getByLabelText('搜索现有科研资料'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
