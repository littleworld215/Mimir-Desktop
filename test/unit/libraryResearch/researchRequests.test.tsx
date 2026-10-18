// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ResearchWorkspace } from '../../../src/components/modules/library/research/ResearchWorkspace'
import * as apiModule from '../../../src/lib/libraryResearchApi'
import type { ResearchApi } from '../../../shared/libraryResearchContracts'
import { uiFixtures, uiScope, uiState } from './uiFixtures'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('旧项目迟到启动结果不能覆盖新项目的scope与列表', async () => {
  let release!: (value: unknown) => void
  const { summary } = uiFixtures()
  const overview = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue({ ok: true, ...uiState, scope: { ...uiScope, spaceEpoch: 'new' }, questionCount: 1, packCount: 0 })
  const listQuestions = vi.fn().mockResolvedValue({ ok: true, ...uiState, total: 1, page: 1, pageSize: 50, items: [{ ...summary, title: '新项目问题', projectId: 'project-2' }] })
  vi.spyOn(apiModule, 'libraryResearchApi').mockReturnValue({ overview, listQuestions } as unknown as ResearchApi)
  const projects = [{ id: 'project-1', title: '旧课题', createdAt: '', updatedAt: '' }, { id: 'project-2', title: '新课题', createdAt: '', updatedAt: '' }]
  const view = render(<ResearchWorkspace projectId="project-1" papers={[]} projects={projects} />)
  view.rerender(<ResearchWorkspace projectId="project-2" papers={[]} projects={projects} />)
  await screen.findByRole('button', { name: '打开问题 新项目问题' })
  release({ ok: true, ...uiState, scope: uiScope, questionCount: 99, packCount: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(listQuestions.mock.calls.every(([r]) => r.scope.spaceEpoch === 'new')).toBe(true)
})
it('启动读取失败后刷新可重试，而不是永久停留在无scope状态', async () => {
  const { summary } = uiFixtures()
  const overview = vi.fn().mockResolvedValueOnce({ ok: false, code: 'WRITE_FAILED', message: '启动暂不可用' }).mockResolvedValue({ ok: true, ...uiState, scope: uiScope, questionCount: 1, packCount: 0 })
  const listQuestions = vi.fn().mockResolvedValue({ ok: true, ...uiState, total: 1, page: 1, pageSize: 50, items: [summary] })
  vi.spyOn(apiModule, 'libraryResearchApi').mockReturnValue({ overview, listQuestions } as unknown as ResearchApi)
  render(<ResearchWorkspace projectId="project-1" papers={[]} projects={[{ id: 'project-1', title: '课题', createdAt: '', updatedAt: '' }]} />)
  await screen.findByText('启动暂不可用')
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }))
  await screen.findByRole('button', { name: `打开问题 ${summary.title}` })
  expect(overview).toHaveBeenCalledTimes(2)
})
