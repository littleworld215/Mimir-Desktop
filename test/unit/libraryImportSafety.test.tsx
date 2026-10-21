// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Library } from '../../src/components/modules/library/Library'
import { registerEvidenceEditor } from '../../src/lib/evidenceEditGuard'
import { SPACE_CHANGED_EVENT } from '../../src/lib/agentContext'

const project = { id: 'project-1', title: '旧课题', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const web = { title: 'T2I Fairness', url: 'https://example.org/target', content: '目标网页摘要', engine: 'test', category: 'science', publishedDate: '' }
const unrelated = { id: '2601.00001', title: 'Ocean Chemistry', authors: ['A. Scientist'], summary: '海洋研究', published: '2026-01-02', url: 'https://arxiv.org/abs/2601.00001' }
const target = { ...unrelated, id: '2601.00002', title: 'T2I Fairness', source: 'openalex' as const, url: 'https://arxiv.org/abs/2601.00002' }

function setup() {
  const library = {
    listProjects: vi.fn().mockResolvedValue({ ok: true, projects: [project] }),
    listPapers: vi.fn().mockResolvedValue({ ok: true, papers: [] }),
    listSubscriptions: vi.fn().mockResolvedValue({ ok: true, subscriptions: [] }),
    createProject: vi.fn().mockResolvedValue({ ok: false, message: '合成磁盘错误' }),
    updateProject: vi.fn().mockResolvedValue({ ok: false, message: '合成重命名失败' }),
    searchWeb: vi.fn().mockResolvedValue({ ok: true, entries: [web] }),
    searchArxiv: vi.fn().mockResolvedValue({ ok: true, entries: [unrelated, target] }),
    importPaper: vi.fn().mockResolvedValue({ ok: true, imported: true })
  }
  window.electronAPI = { library } as never
  const view = render(<Library />)
  return { library, ...view }
}

async function beginCreate() {
  fireEvent.click(await screen.findByText('新建项目'))
  fireEvent.change(screen.getByPlaceholderText('项目名称'), { target: { value: '我的新课题' } })
  fireEvent.click(screen.getByTitle('创建'))
}

async function beginWebMatch() {
  fireEvent.click(screen.getByText('Web', { exact: true }))
  fireEvent.change(screen.getByPlaceholderText('搜索网页文献...'), { target: { value: 'fairness' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索', exact: true }))
  fireEvent.click(await screen.findByTitle(/按标题.*候选/))
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('创建返回失败保留标题和编辑器，重试成功后才清空', async () => {
  const { library } = setup()
  await beginCreate()
  await screen.findByText('合成磁盘错误')
  expect((screen.getByPlaceholderText('项目名称') as HTMLInputElement).value).toBe('我的新课题')
  library.createProject.mockResolvedValueOnce({ ok: true, project: { ...project, id: 'new' } } as never)
  fireEvent.click(screen.getByTitle('创建'))
  await waitFor(() => expect(screen.queryByPlaceholderText('项目名称')).toBeNull())
  expect(library.createProject).toHaveBeenLastCalledWith('我的新课题')
})

it('创建抛出异常仍保留输入且展示错误', async () => {
  const { library } = setup()
  library.createProject.mockRejectedValueOnce(new Error('连接中断'))
  await beginCreate()
  await screen.findByText('连接中断')
  expect((screen.getByPlaceholderText('项目名称') as HTMLInputElement).value).toBe('我的新课题')
})

it('取消脏表单离开时不创建也不清空新课题', async () => {
  const { library } = setup()
  const unregister = registerEvidenceEditor({ isDirty: () => true, isBusy: () => false, save: async () => false, discard() {} })
  try {
    await beginCreate()
    await waitFor(() => expect((screen.getByTitle('创建') as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByPlaceholderText('项目名称') as HTMLInputElement).value).toBe('我的新课题')
    expect(library.createProject).not.toHaveBeenCalled()
  } finally { unregister() }
})

it('重命名失败保留新标题，重试成功才结束编辑', async () => {
  const { library } = setup()
  fireEvent.click(await screen.findByTitle('重命名'))
  fireEvent.change(screen.getByDisplayValue('旧课题'), { target: { value: '新标题' } })
  fireEvent.click(screen.getByTitle('保存'))
  await screen.findByText('合成重命名失败')
  expect(screen.getByDisplayValue('新标题')).toBeTruthy()
  library.updateProject.mockResolvedValueOnce({ ok: true } as never)
  fireEvent.click(screen.getByTitle('保存'))
  await waitFor(() => expect(screen.queryByDisplayValue('新标题')).toBeNull())
})

it('网页结果不能直接导入无关首条；明确选择候选后才导入', async () => {
  const { library } = setup()
  await beginWebMatch()
  const dialog = await screen.findByRole('dialog', { name: '核对候选论文' })
  expect(library.importPaper).not.toHaveBeenCalled()
  expect(within(dialog).getByText(web.url)).toBeTruthy()
  expect(within(dialog).getByText(unrelated.title)).toBeTruthy()
  expect(within(dialog).getByText('来源：openalex')).toBeTruthy()
  expect((within(dialog).getByRole('button', { name: '确认导入' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('radio', { name: /T2I Fairness/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: '确认导入' }))
  await waitFor(() => expect(library.importPaper).toHaveBeenCalledWith(target, undefined))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('取消候选核对不写入文献库', async () => {
  const { library } = setup()
  await beginWebMatch()
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(library.importPaper).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('候选导入失败保留候选与选择，允许重试', async () => {
  const { library } = setup()
  library.importPaper.mockResolvedValueOnce({ ok: false, message: '写入失败' } as never)
  await beginWebMatch()
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: /T2I Fairness/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: '确认导入' }))
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '写入失败')
  expect((within(dialog).getByRole('radio', { name: /T2I Fairness/ }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: '确认导入' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('项目切换使迟到候选失效，不能向新项目导入旧请求', async () => {
  const { library } = setup()
  let finish!: (value: unknown) => void
  library.searchArxiv.mockReturnValueOnce(new Promise(resolve => { finish = resolve }) as never)
  await beginWebMatch()
  fireEvent.click(screen.getByTitle('旧课题'))
  await act(async () => { finish({ ok: true, entries: [target] }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(library.importPaper).not.toHaveBeenCalled()
})

it('重命名异常保留输入，错误可读且可以重试', async () => {
  const { library } = setup()
  library.updateProject.mockRejectedValueOnce(new Error('合成连接错误'))
  fireEvent.click(await screen.findByTitle('重命名'))
  fireEvent.change(screen.getByDisplayValue('旧课题'), { target: { value: '保留标题' } })
  fireEvent.click(screen.getByTitle('保存'))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '合成连接错误')
  expect(screen.getByDisplayValue('保留标题')).toBeTruthy()
})

it('保存期间禁用输入、取消和重复提交，不静默丢弃修改', async () => {
  const { library } = setup()
  let finish!: (value: unknown) => void
  library.createProject.mockReturnValueOnce(new Promise(resolve => { finish = resolve }) as never)
  await beginCreate()
  await waitFor(() => expect(library.createProject).toHaveBeenCalledOnce())
  expect((screen.getByPlaceholderText('项目名称') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByTitle('取消') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByTitle('创建'))
  expect(library.createProject).toHaveBeenCalledOnce()
  await act(async () => { finish({ ok: false, message: '重试' }) })
  expect((screen.getByPlaceholderText('项目名称') as HTMLInputElement).value).toBe('我的新课题')
})

it('中文输入法确认 Enter 不提交项目', async () => {
  const { library } = setup()
  fireEvent.click(await screen.findByText('新建项目'))
  const input = screen.getByPlaceholderText('项目名称')
  fireEvent.change(input, { target: { value: '输入法文字' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
  expect(library.createProject).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('输入法文字')).toBeTruthy()
})

it('无候选或检索失败时不导入，可重新检索', async () => {
  const { library } = setup()
  library.searchArxiv.mockResolvedValueOnce({ ok: true, entries: [] })
  await beginWebMatch()
  await screen.findByText(/未找到候选论文/)
  expect(library.importPaper).not.toHaveBeenCalled()
  library.searchArxiv.mockRejectedValueOnce(new Error('合成网络错误'))
  fireEvent.click(screen.getByTitle(/按标题.*候选/))
  await screen.findByText('合成网络错误')
  expect(library.importPaper).not.toHaveBeenCalled()
})

it('原生 arXiv 搜索结果继续直接导入，不额外匹配网页', async () => {
  const { library } = setup()
  fireEvent.change(screen.getByPlaceholderText('搜索 arXiv 论文...'), { target: { value: 'fairness' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索', exact: true }))
  await screen.findByText('Ocean Chemistry')
  fireEvent.click(screen.getAllByTitle('导入文献库')[1]!)
  await waitFor(() => expect(library.importPaper).toHaveBeenCalledWith(target, undefined))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('空间变化或模块离开后迟到候选不再弹窗或写入', async () => {
  const { library, unmount } = setup()
  let finish!: (value: unknown) => void
  library.searchArxiv.mockReturnValueOnce(new Promise(resolve => { finish = resolve }) as never)
  await beginWebMatch()
  act(() => window.dispatchEvent(new CustomEvent(SPACE_CHANGED_EVENT)))
  unmount()
  await act(async () => { finish({ ok: true, entries: [target] }) })
  expect(library.importPaper).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['throw', 'reply'])('创建已成功但列表刷新失败（%s）时不诱导再次创建重复项目', async failure => {
  const { library } = setup()
  await screen.findByTitle('旧课题')
  library.createProject.mockResolvedValueOnce({ ok: true, project: { ...project, id: 'new' } } as never)
  if (failure === 'throw') library.listProjects.mockRejectedValueOnce(new Error('刷新中断'))
  else library.listProjects.mockResolvedValueOnce({ ok: false, message: '刷新中断' } as never)
  await beginCreate()
  await waitFor(() => expect(screen.queryByPlaceholderText('项目名称')).toBeNull())
  expect(await screen.findByText(/已创建.*刷新失败/)).toBeTruthy()
  expect(library.createProject).toHaveBeenCalledOnce()
})
