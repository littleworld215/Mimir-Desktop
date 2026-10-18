// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { registerEvidenceEditor } from '../../../src/lib/evidenceEditGuard'
import { Library } from '../../../src/components/modules/library/Library'

vi.mock('../../../src/components/modules/library/ProjectBar', () => ({ ProjectBar: (props: { onCreate(title: string): Promise<void>; onDelete(id: string): Promise<void> }) => <><button onClick={() => void props.onCreate('新课题')}>测试创建</button><button onClick={() => void props.onDelete('project-1')}>测试删除</button></> }))
vi.mock('../../../src/components/modules/library/SearchPanel', () => ({ SearchPanel: () => null }))
vi.mock('../../../src/components/modules/library/SubscriptionsBar', () => ({ SubscriptionsBar: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('新建和删除课题均不能绕过脏研究表单；忙时连原生丢弃也不放行', async () => {
  const createProject = vi.fn().mockResolvedValue({ ok: true }), deleteProject = vi.fn().mockResolvedValue({ ok: true })
  const listProjects = vi.fn().mockResolvedValue({ ok: true, projects: [] })
  window.electronAPI = { library: { listProjects, listPapers: vi.fn().mockResolvedValue({ ok: true, papers: [] }), listSubscriptions: vi.fn().mockResolvedValue({ ok: true, subscriptions: [] }), createProject, deleteProject } } as never
  let busy = false
  const unregister = registerEvidenceEditor({ isDirty: () => true, isBusy: () => busy, save: async () => false, discard: () => {} })
  try {
    render(<Library />)
    await waitFor(() => expect(listProjects).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByText('测试创建')); fireEvent.click(screen.getByText('测试删除'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(createProject).not.toHaveBeenCalled(); expect(deleteProject).not.toHaveBeenCalled()
    busy = true
    fireEvent.click(screen.getByText('测试创建')); fireEvent.click(screen.getByText('测试删除'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(createProject).not.toHaveBeenCalled(); expect(deleteProject).not.toHaveBeenCalled()
  } finally { unregister() }
})
