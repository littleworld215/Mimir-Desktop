// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Library } from '../../src/components/modules/library/Library'

const first = {
  arxivId: '2601.00001v2', title: 'Text-to-Image Fairness', authors: ['Alice Example'],
  summary: '多语言生成研究', notes: '评价器独立，需检查拒答', tags: ['culture'], projectIds: ['p1'],
  addedAt: '2026-10-21', url: 'https://example.org/first'
}
const second = { ...first, arxivId: 'doi:10.1/other', title: 'Ocean Chemistry', authors: ['Bob'], summary: '海洋测量', notes: '', tags: ['ocean'], projectIds: [] }

async function setup() {
  const library = {
    listProjects: vi.fn().mockResolvedValue({ ok: true, projects: [{ id: 'p1', title: '科研课题', createdAt: '', updatedAt: '' }] }),
    listPapers: vi.fn().mockResolvedValue({ ok: true, papers: [first, second] }),
    listSubscriptions: vi.fn().mockResolvedValue({ ok: true, subscriptions: [] }),
    searchArxiv: vi.fn(), searchWeb: vi.fn()
  }
  window.electronAPI = { library } as never
  render(<Library />)
  await screen.findByRole('heading', { name: 'Ocean Chemistry' })
  return library
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['FAIRNESS', 'alice', '2601.00001v2', '多语言', '拒答', 'culture'])('库内关键词%s覆盖字段且不触发联网', async keyword => {
  const library = await setup()
  fireEvent.change(screen.getByRole('searchbox', { name: '库内检索' }), { target: { value: keyword } })
  expect(screen.getByRole('heading', { name: first.title })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: second.title })).toBeNull()
  expect(library.searchArxiv).not.toHaveBeenCalled()
  expect(library.searchWeb).not.toHaveBeenCalled()
  expect(library.listPapers).toHaveBeenCalledOnce()
})

it('多关键词跨字段同时匹配，兼容全角文字；清除后恢复原列表', async () => {
  await setup()
  const search = screen.getByRole('searchbox', { name: '库内检索' })
  fireEvent.change(search, { target: { value: 'ＦＡＩＲＮＥＳＳ   拒答' } })
  expect(screen.queryByRole('heading', { name: second.title })).toBeNull()
  expect(screen.getByRole('heading', { name: first.title })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '清除库内检索' }))
  expect(screen.getByRole('heading', { name: second.title })).toBeTruthy()
  expect((search as HTMLInputElement).value).toBe('')
})

it('项目与关键词组合筛选，未命中有明确空态且不会修改文献', async () => {
  const library = await setup()
  await act(async () => { fireEvent.click(screen.getByTitle('科研课题')) })
  fireEvent.change(screen.getByRole('searchbox', { name: '库内检索' }), { target: { value: 'Ocean' } })
  expect(screen.getByText('当前筛选没有匹配的文献')).toBeTruthy()
  expect(screen.getByText('1 篇 · 科研课题')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: second.title })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByTitle('全部项目')) })
  expect(screen.getByRole('heading', { name: second.title })).toBeTruthy()
  expect(first.notes).toBe('评价器独立，需检查拒答')
  expect(library.listPapers).toHaveBeenCalledOnce()
})

it.each(['Ocean', '完全不匹配'])('筛选%s暂时隐藏卡片时保留尚未保存的笔记和标签草稿', async keyword => {
  await setup()
  const heading = screen.getByRole('heading', { name: first.title })
  fireEvent.click(heading)
  const card = heading.closest('div.group')! as HTMLElement
  const editors = within(card).getAllByRole('button', { name: '编辑', exact: true })
  fireEvent.click(editors[0]!)
  const tags = within(card).getByPlaceholderText('逗号分隔，如 survey, llm')
  fireEvent.change(tags, { target: { value: '未保存标签' } })
  fireEvent.click(editors[1]!)
  const notes = within(card).getAllByRole('textbox').find(node => node.tagName === 'TEXTAREA')!
  fireEvent.change(notes, { target: { value: '未保存笔记草稿' } })
  fireEvent.change(screen.getByRole('searchbox', { name: '库内检索' }), { target: { value: keyword } })
  expect(screen.queryByRole('heading', { name: first.title })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '清除库内检索' }))
  expect(screen.getByDisplayValue('未保存标签')).toBeTruthy()
  expect(screen.getByDisplayValue('未保存笔记草稿')).toBeTruthy()
})
