import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { researchIpcHarness } from './ipcHarness'
let h: ReturnType<typeof researchIpcHarness>
beforeEach(() => { h = researchIpcHarness() })
afterEach(() => h.clean())
async function preview() {
  const reply = await h.call('export', { ...h.exportRequest, mode: 'preview' })
  if (!reply.ok) throw Error(reply.message)
  return reply
}
it('预览与实际文件逐字一致，取消/已有目标/伪造路径不覆盖资料', async () => {
  const p = await preview()
  expect(p.entryCount).toBe(2); expect(p.uniqueCardCount).toBe(1)
  expect(await h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken })).toMatchObject({ ok: true, canceled: true, saved: false })
  h.state.path = join(h.root, 'new.md')
  expect(await h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken, path: 'C:/secret' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken })).toMatchObject({ ok: true, saved: true })
  expect(readFileSync(h.state.path, 'utf8')).toBe(p.markdown)
  expect(await h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken })).toMatchObject({ ok: false, code: 'WRITE_FAILED' })
  expect(readFileSync(h.state.path, 'utf8')).toBe(p.markdown)
})
it('observationChangedWithoutRevisionRejectsSave，保存窗口后重验来源观察', async () => {
  const p = await preview(); h.state.path = join(h.root, 'changed.md')
  h.state.beforeDialogReturn = () => { h.observations.set(`${h.cards[0]!.id}:1`, { status: 'changed' }) }
  expect(await h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken })).toMatchObject({ ok: false, code: 'CONFLICT' })
  expect(existsSync(h.state.path)).toBe(false)
})
it('dialogDuringSpaceChangeNeverPublishes，保存窗口期间切空间拒绝', async () => {
  const p = await preview(); h.state.path = join(h.root, 'stale.md')
  h.state.beforeDialogReturn = () => { h.ctx.scope.epoch = 'next' }
  expect(await h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken })).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
  expect(existsSync(h.state.path)).toBe(false)
})
it('racedDestinationStayUnchanged，窗口返回前出现同名目标也不能覆盖', async () => {
  const p = await preview(); h.state.path = join(h.root, 'raced.md')
  h.state.beforeDialogReturn = () => { writeFileSync(h.state.path!, '用户已有资料') }
  expect(await h.call('export', { ...h.exportRequest, mode: 'save', previewToken: p.previewToken })).toMatchObject({ ok: false, code: 'WRITE_FAILED' })
  expect(readFileSync(h.state.path, 'utf8')).toBe('用户已有资料')
})
