// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { MaterialPackEditor } from '../../../src/components/modules/library/research/MaterialPackEditor'
import * as apiModule from '../../../src/lib/libraryResearchApi'
import type { ResearchApi } from '../../../shared/libraryResearchContracts'
import { uiFixtures, uiScope, uiState } from './uiFixtures'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('上移保留既有条目身份，只提交元数据而不能伪造固定版本', async () => {
  const { packReply, summary } = uiFixtures(), initial = structuredClone(packReply.pack.versions[0]!)
  initial.items.push({ ...initial.items[0]!, id: randomUUID(), questionId: randomUUID() })
  const save = vi.fn().mockResolvedValue({ ok: false, code: 'WRITE_FAILED', message: '输入保留' })
  render(<MaterialPackEditor scope={uiScope} projectId="project-1" initial={initial} revision={3} evidenceRevision={1} questions={[summary]} save={save} />)
  fireEvent.click(screen.getByRole('button', { name: '上移条目 2' }))
  fireEvent.change(screen.getByLabelText('拟写小节 1'), { target: { value: '讨论' } })
  fireEvent.click(screen.getByRole('button', { name: '保存素材包' }))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')))
  expect(save.mock.calls[0]![0].items[0]).toEqual({ kind: 'existing', itemId: initial.items[1]!.id, section: '讨论', note: initial.items[1]!.note })
  expect((screen.getByLabelText('拟写小节 1') as HTMLInputElement).value).toBe('讨论')
})

it('素材Esc取消经同一守卫，忙时不丢弃，清理注册后才卸载', async () => {
  const { packReply, summary } = uiFixtures(), onCancel = vi.fn(), save = vi.fn()
  const props = { scope: uiScope, projectId: 'project-1', initial: packReply.pack.versions[0], revision: 3, evidenceRevision: 1, questions: [summary], save, onCancel }
  const view = render(<MaterialPackEditor {...props} externalBusy />)
  fireEvent.keyDown(screen.getByLabelText('素材包标题'), { key: 'Escape' })
  await new Promise(resolve => setTimeout(resolve, 0)); expect(onCancel).not.toHaveBeenCalled()
  view.rerender(<MaterialPackEditor {...props} externalBusy={false} />)
  fireEvent.keyDown(screen.getByLabelText('素材包标题'), { key: 'Escape' })
  await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
})

it('默认问题与选项均限定素材包所属课题，排除异课题与已归档问题', () => {
  const { packReply, summary } = uiFixtures()
  render(<MaterialPackEditor scope={uiScope} projectId="other-project" initial={packReply.pack.versions[0]} revision={3} evidenceRevision={1} questions={[
    { ...summary, id: 'foreign', projectId: 'other-project' },
    { ...summary, id: 'archived', archived: true }, summary,
  ]} save={vi.fn()} />)
  expect((screen.getByLabelText('选入问题') as HTMLSelectElement).value).toBe(summary.id)
  expect(screen.getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['', summary.id])
  expect((screen.getByRole('button', { name: '从问题组选入证据' }) as HTMLButtonElement).disabled).toBe(false)
})

it('异步刷新保留有效选择与编辑内容，失效时回退，没有同课题问题则禁用选入', () => {
  const { summary } = uiFixtures(), second = { ...summary, id: 'second' }, foreign = { ...summary, id: 'foreign', projectId: 'other-project' }
  const props = { scope: uiScope, projectId: 'project-1', revision: 3, evidenceRevision: 1, save: vi.fn() }
  const view = render(<MaterialPackEditor {...props} questions={[]} />)
  const select = () => screen.getByLabelText('选入问题') as HTMLSelectElement
  const disabled = () => (screen.getByRole('button', { name: '从问题组选入证据' }) as HTMLButtonElement).disabled
  expect(disabled()).toBe(true)
  view.rerender(<MaterialPackEditor {...props} questions={[foreign]} />)
  expect(select().value).toBe(''); expect(disabled()).toBe(true)
  view.rerender(<MaterialPackEditor {...props} questions={[foreign, summary, second]} />)
  expect(select().value).toBe(summary.id)
  fireEvent.change(select(), { target: { value: second.id } })
  fireEvent.change(screen.getByLabelText('素材包标题'), { target: { value: '未保存的标题' } })
  view.rerender(<MaterialPackEditor {...props} questions={[summary, second]} />)
  expect(select().value).toBe(second.id)
  view.rerender(<MaterialPackEditor {...props} questions={[{ ...second, archived: true }, summary]} />)
  expect(select().value).toBe(summary.id)
  expect((screen.getByLabelText('素材包标题') as HTMLInputElement).value).toBe('未保存的标题')
  view.rerender(<MaterialPackEditor {...props} questions={[foreign]} />)
  expect(select().value).toBe(''); expect(disabled()).toBe(true)
})

it('证据选择期间问题列表刷新，已选证据仍归属打开时的问题', async () => {
  const { summary } = uiFixtures(), second = { ...summary, id: 'second' }
  const questionDetail = vi.fn().mockResolvedValue({ ok: true, ...uiState, rows: [{ cardId: 'card-original', version: 1, paperTitle: '原问题证据', question: '问题', quote: '摘录', relation: 'unassessed', reviewState: 'draft', sourceStatus: 'unbound', problems: [] }], total: 1, page: 1, pageSize: 50 })
  vi.spyOn(apiModule, 'libraryResearchApi').mockReturnValue({ questionDetail } as unknown as ResearchApi)
  const save = vi.fn().mockResolvedValue({ ok: false, code: 'WRITE_FAILED', message: '保留输入' })
  const props = { scope: uiScope, projectId: 'project-1', revision: 3, evidenceRevision: 1, save }
  const view = render(<MaterialPackEditor {...props} questions={[summary, second]} />)
  fireEvent.click(screen.getByRole('button', { name: '从问题组选入证据' }))
  fireEvent.click(await screen.findByLabelText('选择证据 card-original'))
  view.rerender(<MaterialPackEditor {...props} questions={[second]} />)
  fireEvent.click(screen.getByRole('button', { name: '应用选择' }))
  fireEvent.click(screen.getByRole('button', { name: '保存素材包' }))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(questionDetail.mock.calls.every(([request]) => request.questionId === summary.id)).toBe(true)
  expect(save.mock.calls[0]![0].items).toEqual([{ kind: 'new', questionId: summary.id, cardId: 'card-original', section: '', note: '' }])
})
