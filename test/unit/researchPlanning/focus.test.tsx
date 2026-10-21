// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchPlanning } from '../../../src/components/modules/planning/ResearchPlanning'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

afterEach(cleanup)
it.each(['existing-cancel', 'new-cancel', 'new-save', 'filtered-save'] as const)('%s关闭后等待新列表，按稳定身份返回或回退到新建入口', async mode => {
  const scope = { workspaceId: 's', spaceEpoch: 'e' }, defaults = emptyPlanningDocument()
  const item = { ...emptyPlanningInput('project'), id: 'p:[科研]', title: '原课题', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' }
  const existing = mode === 'existing-cancel' || mode === 'filtered-save'
  const response = (items: typeof item[]) => ({ ok: true, scope, revision: 0, items, total: items.length, page: 1, pageSize: 50 })
  let resolveReload!: (value: ReturnType<typeof response>) => void
  const list = vi.fn().mockResolvedValueOnce(response(existing ? [item] : [])).mockImplementation(() => new Promise(resolve => { resolveReload = resolve }))
  const save = vi.fn().mockResolvedValue({ ok: true, scope, revision: 1 })
  window.electronAPI = { researchPlanning: {
    bootstrap: vi.fn().mockResolvedValue({ ok: true, scope, revision: 0, total: 0, types: defaults.types, collections: defaults.collections }),
    list, summary: vi.fn().mockResolvedValue({ ok: true, scope, revision: 0, nextActions: {} }), save
  } } as unknown as typeof window.electronAPI
  render(<ResearchPlanning />)
  const newButton = await screen.findByRole('button', { name: '新建科研项目', exact: true })
  await waitFor(() => expect(newButton).toHaveProperty('disabled', false))
  const entry = existing ? screen.getByRole('button', { name: '原课题', exact: true }) : newButton
  entry.focus(); fireEvent.click(entry)
  await screen.findByLabelText('标题')
  if (mode.endsWith('save')) {
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '新标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存记录' }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
  } else fireEvent.click(screen.getByRole('button', { name: '取消编辑' }))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(newButton).toHaveProperty('disabled', true)
  await act(async () => { resolveReload(response(mode === 'existing-cancel' ? [{ ...item }] : [])) })
  await waitFor(() => expect(newButton).toHaveProperty('disabled', false))
  const target = mode === 'existing-cancel' ? screen.getByRole('button', { name: '原课题', exact: true }) : newButton
  await waitFor(() => expect(document.activeElement).toBe(target))
})
