// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Library } from '../../src/components/modules/library/Library'
import { parseReadingNotes } from '../../src/components/modules/library/types'
import { hasEvidenceWork, requestEvidenceLeave, setEvidenceLeaveChooser } from '../../src/lib/evidenceEditGuard'

const original = {
  arxivId: '2601.00001', title: '合成文献', authors: ['Alice'], summary: '摘要', url: 'https://example.org/paper',
  notes: '[2026-01-01 10:00]\n原笔记', tags: ['old'], projectIds: [], addedAt: '2026-01-01', pdfPath: 'C:/synthetic/paper.pdf'
}
async function setup(inProject = false) {
  let stored = { ...original, tags: [...original.tags], projectIds: inProject ? ['project-1'] : [] }
  const library = {
    listPapers: vi.fn().mockImplementation(async () => ({ ok: true, papers: [stored] })),
    listProjects: vi.fn().mockResolvedValue({ ok: true, projects: [{ id: 'project-1', title: '测试项目', createdAt: '', updatedAt: '' }] }),
    listSubscriptions: vi.fn().mockResolvedValue({ ok: true, subscriptions: [] }),
    updatePaper: vi.fn().mockImplementation(async patch => { stored = { ...stored, ...patch }; return { ok: true, paper: stored } })
  }
  window.electronAPI = { library } as never
  const view = render(<Library />)
  const title = await screen.findByRole('heading', { name: original.title })
  fireEvent.click(title)
  const card = title.closest('div.group')! as HTMLElement
  return { library, card, ...view }
}
function editNotes(card: HTMLElement) {
  const button = within(card).getAllByRole('button', { name: '编辑', exact: true }).at(-1)!
  fireEvent.click(button)
  const input = within(card).getByPlaceholderText('写下你的阅读笔记...')
  fireEvent.change(input, { target: { value: '未保存的新笔记' } })
  return input
}
function editTags(card: HTMLElement) {
  fireEvent.click(within(card).getAllByRole('button', { name: '编辑', exact: true })[0]!)
  const input = within(card).getByPlaceholderText('逗号分隔，如 survey, llm')
  fireEvent.change(input, { target: { value: 'new, 保留' } })
  return input
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('阅读记录解析保留同一记录中的空行和全部段落', () => {
  expect(parseReadingNotes('[2026-01-01 10:00]\n第一段\n\n第二段\n\n[2026-01-02 11:00]\n下一条'))
    .toEqual([{ at: '2026-01-01 10:00', text: '第一段\n\n第二段' }, { at: '2026-01-02 11:00', text: '下一条' }])
})

it('卡片笔记失败保留输入和错误，重试成功才结束编辑', async () => {
  const { card, library } = await setup()
  library.updatePaper.mockResolvedValueOnce({ ok: false, message: '合成磁盘错误' } as never)
  editNotes(card)
  fireEvent.click(within(card).getByRole('button', { name: '保存', exact: true }))
  expect(await within(card).findByRole('alert')).toHaveProperty('textContent', '合成磁盘错误')
  expect(within(card).getByDisplayValue('未保存的新笔记')).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: '保存', exact: true }))
  await waitFor(() => expect(within(card).queryByPlaceholderText('写下你的阅读笔记...')).toBeNull())
  expect(await screen.findByText('未保存的新笔记')).toBeTruthy()
})

it('标签保存异常保留编辑器且显示就地错误', async () => {
  const { card, library } = await setup()
  library.updatePaper.mockRejectedValueOnce(new Error('合成连接中断'))
  editTags(card)
  fireEvent.click(within(card).getByRole('button', { name: '保存', exact: true }))
  expect(await within(card).findByRole('alert')).toHaveProperty('textContent', '合成连接中断')
  expect(within(card).getByDisplayValue('new, 保留')).toBeTruthy()
})

it('保存笔记不会卸载同一卡片未保存的标签编辑器', async () => {
  const { card } = await setup()
  editTags(card)
  editNotes(card)
  fireEvent.click(within(card).getAllByRole('button', { name: '保存', exact: true })[1]!)
  await waitFor(() => expect(within(card).queryByPlaceholderText('写下你的阅读笔记...')).toBeNull())
  expect(screen.getByDisplayValue('new, 保留')).toBeTruthy()
  expect(await screen.findByText('未保存的新笔记')).toBeTruthy()
})

it('卡片保存中禁用输入与取消，重复点击只提交一次', async () => {
  const { card, library } = await setup()
  let finish!: (value: unknown) => void
  library.updatePaper.mockReturnValueOnce(new Promise(resolve => { finish = resolve }) as never)
  const input = editNotes(card)
  fireEvent.click(within(card).getByRole('button', { name: '保存', exact: true }))
  expect((input as HTMLTextAreaElement).disabled).toBe(true)
  expect((within(card).getByRole('button', { name: '取消', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(card).getByRole('button', { name: '保存', exact: true }))
  expect(library.updatePaper).toHaveBeenCalledOnce()
  expect(await requestEvidenceLeave('discard')).toBe(false)
  await act(async () => { finish({ ok: false, message: '未写入' }) })
  expect(screen.getByDisplayValue('未保存的新笔记')).toBeTruthy()
})

it('卡片脏编辑阻止离开，保存失败仍留在原处，明确丢弃才清除', async () => {
  const { card, library } = await setup()
  editNotes(card)
  expect(hasEvidenceWork()).toBe(true)
  expect(await requestEvidenceLeave('cancel')).toBe(false)
  library.updatePaper.mockResolvedValueOnce({ ok: false, message: '未保存' } as never)
  let accepted = true
  await act(async () => { accepted = await requestEvidenceLeave('save') })
  expect(accepted).toBe(false)
  expect(screen.getByDisplayValue('未保存的新笔记')).toBeTruthy()
  await act(async () => { accepted = await requestEvidenceLeave('discard') })
  expect(accepted).toBe(true)
  expect(screen.queryByDisplayValue('未保存的新笔记')).toBeNull()
  expect(hasEvidenceWork()).toBe(false)
})

it('保存后离开时同一卡片笔记与标签合成一次更新，卸载释放守卫', async () => {
  const { card, library, unmount } = await setup()
  editTags(card); editNotes(card)
  let accepted = false
  await act(async () => { accepted = await requestEvidenceLeave('save') })
  expect(accepted).toBe(true)
  expect(library.updatePaper).toHaveBeenCalledOnce()
  expect(library.updatePaper).toHaveBeenCalledWith({ arxivId: original.arxivId, notes: '未保存的新笔记', tags: ['new', '保留'] })
  unmount()
  expect(hasEvidenceWork()).toBe(false)
})

it('阅读器追加失败保留原文和输入，重试成功只追加一次', async () => {
  const { card, library } = await setup()
  fireEvent.click(within(card).getByTitle('内嵌阅读 PDF'))
  const reader = await screen.findByRole('dialog', { name: '文献阅读器' })
  fireEvent.click(within(reader).getByRole('button', { name: '添加', exact: true }))
  fireEvent.change(within(reader).getByPlaceholderText('记录阅读心得、关键公式、待办...'), { target: { value: '新的阅读记录' } })
  library.updatePaper.mockResolvedValueOnce({ ok: false, message: '追加失败' } as never)
  fireEvent.click(within(reader).getByRole('button', { name: '保存', exact: true }))
  expect(await within(reader).findByRole('alert')).toHaveProperty('textContent', '追加失败')
  expect(within(reader).getByDisplayValue('新的阅读记录')).toBeTruthy()
  expect(within(reader).getByText('原笔记')).toBeTruthy()
  expect(within(reader).queryByText('新的阅读记录', { selector: 'p' })).toBeNull()
  fireEvent.click(within(reader).getByRole('button', { name: '保存', exact: true }))
  await waitFor(() => expect(within(reader).queryByPlaceholderText('记录阅读心得、关键公式、待办...')).toBeNull())
  expect(within(reader).getAllByText('新的阅读记录')).toHaveLength(1)
})

it('阅读器新增笔记未保存时关闭不能绕过离开保护', async () => {
  const { card } = await setup()
  fireEvent.click(within(card).getByTitle('内嵌阅读 PDF'))
  const reader = await screen.findByRole('dialog', { name: '文献阅读器' })
  fireEvent.click(within(reader).getByRole('button', { name: '添加', exact: true }))
  fireEvent.change(within(reader).getByPlaceholderText('记录阅读心得、关键公式、待办...'), { target: { value: '未保存' } })
  await act(async () => { fireEvent.click(within(reader).getByTitle('关闭')) })
  expect(screen.getByRole('dialog', { name: '文献阅读器' })).toBeTruthy()
  expect(within(reader).getByDisplayValue('未保存')).toBeTruthy()
})

it('阅读器保存期间禁止重复提交与取消，Esc不能丢弃未完成请求', async () => {
  const { card, library } = await setup()
  fireEvent.click(within(card).getByTitle('内嵌阅读 PDF'))
  const reader = await screen.findByRole('dialog', { name: '文献阅读器' })
  fireEvent.click(within(reader).getByRole('button', { name: '添加', exact: true }))
  const input = within(reader).getByPlaceholderText('记录阅读心得、关键公式、待办...')
  fireEvent.change(input, { target: { value: '处理中草稿' } })
  let finish!: (value: unknown) => void
  library.updatePaper.mockReturnValueOnce(new Promise(resolve => { finish = resolve }) as never)
  fireEvent.click(within(reader).getByRole('button', { name: '保存', exact: true }))
  expect((input as HTMLTextAreaElement).disabled).toBe(true)
  expect((within(reader).getByRole('button', { name: '取消', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(reader).getByRole('button', { name: '保存', exact: true }))
  await act(async () => { fireEvent.keyDown(reader, { key: 'Escape' }) })
  expect(screen.getByRole('dialog', { name: '文献阅读器' })).toBeTruthy()
  expect(library.updatePaper).toHaveBeenCalledOnce()
  await act(async () => { finish({ ok: false, message: '仍未保存' }) })
  expect(within(reader).getByDisplayValue('处理中草稿')).toBeTruthy()
})

it.each(['pdf', 'evidence'])('卡片保存后经%s入口打开阅读器，追加必须保留刚保存的新笔记', async entry => {
  const { card, library } = await setup()
  editNotes(card)
  const remove = setEvidenceLeaveChooser(async () => 'save')
  try {
    fireEvent.click(entry === 'pdf' ? within(card).getByTitle('内嵌阅读 PDF') : within(card).getByLabelText('证据卡：合成文献'))
    const reader = await screen.findByRole('dialog', { name: '文献阅读器' })
    if (entry === 'evidence') await act(async () => { fireEvent.click(within(reader).getByRole('tab', { name: '阅读笔记' })) })
    expect(within(reader).getByText('未保存的新笔记')).toBeTruthy()
    fireEvent.click(within(reader).getByRole('button', { name: '添加', exact: true }))
    fireEvent.change(within(reader).getByPlaceholderText('记录阅读心得、关键公式、待办...'), { target: { value: '第二条追加' } })
    fireEvent.click(within(reader).getByRole('button', { name: '保存', exact: true }))
    await waitFor(() => expect(within(reader).queryByPlaceholderText('记录阅读心得、关键公式、待办...')).toBeNull())
    const stored = await library.listPapers()
    expect(stored.papers[0]!.notes).toContain('未保存的新笔记')
    expect(stored.papers[0]!.notes).toContain('第二条追加')
  } finally { remove() }
})

it.each(['cancel', 'save-failure', 'save-success', 'discard'])('解除当前项目关联的%s路径不能静默丢弃草稿', async action => {
  const { card, library } = await setup(true)
  await act(async () => { fireEvent.click(screen.getByTitle('测试项目')) })
  editNotes(card)
  const remove = setEvidenceLeaveChooser(async () => action === 'cancel' ? 'cancel' : action === 'discard' ? 'discard' : 'save')
  try {
    if (action === 'save-failure') library.updatePaper.mockResolvedValueOnce({ ok: false, message: '拒绝写入' } as never)
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '测试项目', exact: true })) })
    if (action === 'cancel' || action === 'save-failure') {
      expect(screen.getByDisplayValue('未保存的新笔记')).toBeTruthy()
      const stored = await library.listPapers()
      expect(stored.papers[0]!.projectIds).toEqual(['project-1'])
      expect(library.updatePaper).toHaveBeenCalledTimes(action === 'cancel' ? 0 : 1)
    } else {
      expect(screen.queryByRole('heading', { name: original.title })).toBeNull()
      const stored = await library.listPapers()
      expect(stored.papers[0]!.projectIds).toEqual([])
      expect(stored.papers[0]!.notes).toBe(action === 'discard' ? original.notes : '未保存的新笔记')
      expect(hasEvidenceWork()).toBe(false)
    }
  } finally { remove() }
})
