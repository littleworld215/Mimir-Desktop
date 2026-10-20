// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EvidenceLeaveDialog } from '../../../src/components/modules/library/evidence/EvidenceLeaveDialog'
import { hasEvidenceWork, registerEvidenceEditor, requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'
afterEach(cleanup)
it('异步丢弃失败必须阻止离开，不能在恢复草稿删除确认前成功', async () => {
  let finish!: () => void, settled = false
  const remove = registerEvidenceEditor({ isDirty: () => true, isBusy: () => false, save: async () => false, discard: () => new Promise<void>(resolve => { finish = resolve }) })
  try {
    const pending = requestEvidenceLeave('discard').then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish(); expect(await pending).toBe(true)
  } finally { remove() }
  const fail = registerEvidenceEditor({ isDirty: () => true, isBusy: () => false, save: async () => false, discard: async () => { throw Error('草稿删除失败') } })
  try { expect(await requestEvidenceLeave('discard')).toBe(false) } finally { fail() }
})
it('失败保存不能批准离开，忙时不能丢弃；成功才放行', async () => {
  let busy = false, dirty = true
  const save = vi.fn(async () => false), discard = vi.fn(() => { dirty = false })
  const remove = registerEvidenceEditor({ isDirty: () => dirty, isBusy: () => busy, save, discard })
  try {
    expect(await requestEvidenceLeave('save')).toBe(false)
    expect(hasEvidenceWork()).toBe(true)
    busy = true; expect(await requestEvidenceLeave('discard')).toBe(false); expect(discard).not.toHaveBeenCalled()
    busy = false; expect(await requestEvidenceLeave('discard')).toBe(true); expect(hasEvidenceWork()).toBe(false)
  } finally { remove() }
})
it('真实离开对话可取消，Esc等于留在这里，关闭时取消未决选择', async () => {
  const remove = registerEvidenceEditor({ isDirty: () => true, isBusy: () => false, save: async () => false, discard: () => {} })
  const view = render(<EvidenceLeaveDialog />)
  try {
    const pending = requestEvidenceLeave()
    await screen.findByRole('dialog', { name: '存在未保存的研究资料编辑' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(await pending).toBe(false)
    const second = requestEvidenceLeave(); await screen.findByRole('dialog'); view.unmount()
    expect(await second).toBe(false)
  } finally { remove() }
})
