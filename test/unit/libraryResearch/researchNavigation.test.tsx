// @vitest-environment jsdom
import { setEvidenceLeaveChooser } from '../../../src/lib/evidenceEditGuard'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchWorkspace } from '../../../src/components/modules/library/research/ResearchWorkspace'
import * as apiModule from '../../../src/lib/libraryResearchApi'
import type { ResearchApi } from '../../../shared/libraryResearchContracts'
import { uiFixtures, uiScope, uiState } from './uiFixtures'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('列表重新读取不会替换正在编辑的表单；取消离开保留内容', async () => {
  const { summary, questionReply } = uiFixtures()
  const api = {
    overview: vi.fn().mockResolvedValue({ ok: true, ...uiState, scope: uiScope, questionCount: 1, packCount: 0 }),
    listQuestions: vi.fn().mockResolvedValueOnce({ ok: true, ...uiState, total: 1, page: 1, pageSize: 50, items: [summary] }).mockResolvedValue({ ok: true, ...uiState, revision: 99, total: 1, page: 1, pageSize: 50, items: [summary] }),
    saveQuestion: vi.fn().mockResolvedValue({ ok: false, code: 'CONFLICT', message: '输入已保留' }),
    questionDetail: vi.fn().mockResolvedValue({ ok: true, ...questionReply, selectedVersion: 1, rows: [], total: 0, page: 1, pageSize: 50, relationCounts: { supports: 0, opposes: 0, mixed: 0, unassessed: 0, unknown: 0 } })
  }
  vi.spyOn(apiModule, 'libraryResearchApi').mockReturnValue(api as unknown as ResearchApi)
  render(<ResearchWorkspace projectId="project-1" papers={[]} projects={[{ id: 'project-1', title: '课题', createdAt: '', updatedAt: '' }]} />)
  fireEvent.click(await screen.findByRole('button', { name: `打开问题 ${summary.title}` }))
  const title = await screen.findByLabelText('问题标题') as HTMLInputElement
  fireEvent.change(title, { target: { value: '尚未保存' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
  await waitFor(() => expect(api.listQuestions).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: '保存问题' }))
  await waitFor(() => expect(api.saveQuestion).toHaveBeenCalledOnce())
  expect(api.saveQuestion.mock.calls[0]![0].expectedRevision).toBe(3)
  fireEvent.click(screen.getByRole('button', { name: '新建问题' }))
  await waitFor(() => expect((screen.getByLabelText('问题标题') as HTMLInputElement).value).toBe('尚未保存'))
  expect(api.questionDetail).toHaveBeenCalledOnce()
})

it('Esc保存并关闭后，迟到的保存后详情不能复活编辑器，焦点回到入口', async () => {
  const { summary, questionReply } = uiFixtures()
  let release!: (value: unknown) => void
  const detail = { ok: true, ...questionReply, selectedVersion: 1, rows: [], total: 0, page: 1, pageSize: 50, relationCounts: { supports: 0, opposes: 0, mixed: 0, unassessed: 0, unknown: 0 } }
  const api = {
    overview: vi.fn().mockResolvedValue({ ok: true, ...uiState, scope: uiScope, questionCount: 1, packCount: 0 }),
    listQuestions: vi.fn().mockResolvedValue({ ok: true, ...uiState, total: 1, page: 1, pageSize: 50, items: [summary] }),
    saveQuestion: vi.fn().mockResolvedValue({ ok: true, ...questionReply }),
    questionDetail: vi.fn().mockResolvedValueOnce(detail).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  }
  vi.spyOn(apiModule, 'libraryResearchApi').mockReturnValue(api as unknown as ResearchApi)
  const remove = setEvidenceLeaveChooser(async () => 'save')
  try {
    render(<ResearchWorkspace projectId="project-1" papers={[]} projects={[{ id: 'project-1', title: '课题', createdAt: '', updatedAt: '' }]} />)
    fireEvent.click(await screen.findByRole('button', { name: `打开问题 ${summary.title}` }))
    const title = await screen.findByLabelText('问题标题')
    fireEvent.change(title, { target: { value: '已保存的新标题' } })
    fireEvent.keyDown(title, { key: 'Escape' })
    await waitFor(() => expect(api.saveQuestion).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByLabelText('问题标题')).toBeNull())
    await act(async () => { release(detail) })
    expect(screen.queryByLabelText('问题标题')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '新建问题' })))
  } finally { remove() }
})