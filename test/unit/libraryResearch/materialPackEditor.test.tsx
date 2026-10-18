// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { MaterialPackEditor } from '../../../src/components/modules/library/research/MaterialPackEditor'
import { uiFixtures, uiScope } from './uiFixtures'
afterEach(cleanup)
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
