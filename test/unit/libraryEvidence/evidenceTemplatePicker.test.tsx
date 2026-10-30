// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EvidenceEditor } from '../../../src/components/modules/library/evidence/EvidenceEditor'
import { hasEvidenceWork } from '../../../src/lib/evidenceEditGuard'
afterEach(cleanup)
it('预览门户里的Ctrl/Cmd+Enter不能冒泡触发原证据保存', async () => {
  const save=vi.fn().mockResolvedValue({ok:false,code:'WRITE_FAILED',message:'不得触发'})
  render(<EvidenceEditor paperId="paper" projectIds={[]} revision={0} save={save} />)
  fireEvent.change(screen.getByLabelText('填写框架'),{target:{value:'t2i-fairness'}})
  fireEvent.click(screen.getByRole('button',{name:'预览空白填写提纲'}))
  const preview=await screen.findByRole('dialog',{name:'插入填写提纲预览'})
  fireEvent.keyDown(preview,{key:'Enter',ctrlKey:true});fireEvent.keyDown(preview,{key:'Enter',metaKey:true})
  await Promise.resolve();expect(save).not.toHaveBeenCalled()
})
it('仅切模式不标脏、不保存，插入框架才产生未保存修改', () => {
  const save = vi.fn()
  render(<EvidenceEditor paperId="paper" projectIds={[]} revision={0} save={save} />)
  fireEvent.change(screen.getByLabelText('填写框架'), { target: { value: 't2i-fairness' } })
  expect(hasEvidenceWork()).toBe(false); expect(save).not.toHaveBeenCalled()
})
it('切换只改提示，预览取消不改输入或保存；显式插入才标脏', async () => {
  const save = vi.fn()
  render(<EvidenceEditor paperId="paper" projectIds={[]} revision={0} save={save} />)
  const quote = screen.getByLabelText('原文摘录') as HTMLTextAreaElement
  fireEvent.change(quote, { target: { value: '已有原文' } })
  fireEvent.change(screen.getByLabelText('填写框架'), { target: { value: 't2i-fairness' } })
  expect((screen.getByLabelText('方法') as HTMLTextAreaElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '预览空白填写提纲' }))
  await screen.findByRole('dialog', { name: '插入填写提纲预览' })
  fireEvent.click(screen.getByRole('button', { name: '取消插入' }))
  expect(quote.value).toBe('已有原文'); expect(save).not.toHaveBeenCalled()
  expect((screen.getByLabelText('方法') as HTMLTextAreaElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: '预览空白填写提纲' }))
  fireEvent.click(await screen.findByRole('button', { name: '仅插入空字段' }))
  expect((screen.getByLabelText('方法') as HTMLTextAreaElement).value).toContain('模型')
  expect(quote.value).toBe('已有原文'); expect(hasEvidenceWork()).toBe(true); expect(save).not.toHaveBeenCalled()
})
