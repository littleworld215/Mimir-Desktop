// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Library } from '../../src/components/modules/library/Library'
const paper = { arxivId: 'synthetic', title: '回收保护文献', authors: [], summary: '', url: '', notes: 'keep', tags: [], projectIds: [], addedAt: '2024-01-01' }
const scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
async function setup() {
  const library = {
    listPapers: vi.fn().mockResolvedValue({ ok: true, papers: [paper], scope }),
    listProjects: vi.fn().mockResolvedValue({ ok: true, projects: [] }),
    listSubscriptions: vi.fn().mockResolvedValue({ ok: true, subscriptions: [] }),
    paperTrash: vi.fn().mockResolvedValue({ ok: true, scope, papers: [{ arxivId: paper.arxivId, title: paper.title, removedAt: '2026-10-22T00:00:00Z', hasPdf: true, tagCount: 1 }] }),
    previewPaperLifecycle: vi.fn().mockResolvedValue({ ok: true, preview: { arxivId: paper.arxivId, title: paper.title, action: 'trash', token: 'token', projectNames: ['课题'], missingProjectIds: [],
      counts: { evidenceCards: 2, evidenceVersions: 3, questions: 1, packs: 1, planningItems: 1, planningDrafts: 0 } } }),
    applyPaperLifecycle: vi.fn().mockResolvedValue({ ok: true })
  }
  window.electronAPI = { library } as never
  render(<Library />)
  await screen.findByRole('heading', { name: paper.title })
  return library
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('移除先显示关联预览，取消零写，失败保留确认窗口并可重试', async () => {
  const api = await setup()
  fireEvent.click(screen.getByTitle('从文献库移除'))
  const dialog = await screen.findByRole('dialog', { name: '移入文献回收站' })
  expect(await within(dialog).findByText(/证据卡 2 张/)).toBeTruthy()
  expect(api.applyPaperLifecycle).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByTitle('从文献库移除'))
  const again = await screen.findByRole('dialog', { name: '移入文献回收站' })
  await within(again).findByText(/证据卡 2 张/)
  api.applyPaperLifecycle.mockResolvedValueOnce({ ok: false, message: '合成磁盘失败' } as never)
  fireEvent.click(within(again).getByRole('button', { name: '确认移入回收站' }))
  expect(await within(again).findByRole('alert')).toHaveProperty('textContent', '合成磁盘失败')
  expect(screen.getByRole('heading', { name: paper.title, hidden: true })).toBeTruthy()
  api.listPapers.mockResolvedValue({ ok: true, papers: [], scope })
  fireEvent.click(within(again).getByRole('button', { name: '确认移入回收站' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.applyPaperLifecycle).toHaveBeenLastCalledWith({ scope, token: 'token' })
})
it('回收站恢复为显式预览；读取失败不显示空库假成功', async () => {
  const api = await setup()
  api.paperTrash.mockResolvedValueOnce({ ok: false, message: '合成读取失败' } as never)
  fireEvent.click(screen.getByRole('button', { name: '文献回收站' }))
  const dialog = await screen.findByRole('dialog', { name: '文献回收站' })
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '合成读取失败')
  fireEvent.click(within(dialog).getByRole('button', { name: '刷新回收站' }))
  fireEvent.click(await within(dialog).findByRole('button', { name: '恢复：' + paper.title }))
  const preview = await screen.findByRole('dialog', { name: '恢复文献' })
  expect(api.applyPaperLifecycle).not.toHaveBeenCalled()
  expect(api.previewPaperLifecycle).toHaveBeenLastCalledWith({ scope, arxivId: paper.arxivId, action: 'restore' })
  expect(within(preview).getByRole('button', { name: '确认恢复' })).toBeTruthy()
})
