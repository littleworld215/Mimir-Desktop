import { afterEach, beforeEach, expect, it } from 'vitest'
import { RESEARCH_CHANNELS } from '../../shared/libraryResearchContracts'
import { registeredResearch, researchIpcHarness } from '../unit/libraryResearch/ipcHarness'
let h: ReturnType<typeof researchIpcHarness>
beforeEach(() => { h = researchIpcHarness() })
afterEach(() => h.clean())
it('恰好13条固定通道，只有overview可无scope，路径和未知键拒绝', async () => {
  expect([...registeredResearch().keys()].sort()).toEqual(Object.values(RESEARCH_CHANNELS).sort())
  expect(registeredResearch().size).toBe(13)
  expect(await h.call('overview', {})).toMatchObject({ ok: true, scope: h.scope, questionCount: 2, packCount: 1 })
  for (const payload of [{ path: 'C:/secret' }, null, []]) expect(await h.call('overview', payload)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await h.call('listQuestions', { filter: { archive: 'exclude' }, page: 1 })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await h.call('overview', { scope: { ...h.scope, spaceEpoch: 'old' } })).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
})
it('主窗口主框架独占；其它sender、iframe和销毁窗口全部拒绝', async () => {
  for (const fake of [{}, { sender: {} }, { sender: h.sender, senderFrame: {} }]) expect(await h.call('overview', {}, fake)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  h.state.closed = true
  expect(await h.call('overview', {})).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
})
it('保存合同拒绝伪造固定版本/可信字段，正常问题写后读且旧revision冲突', async () => {
  expect(await h.call('saveQuestion', { scope: h.scope, expectedRevision: 3, input: { ...h.input, path: 'C:/secret' } })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  const created = await h.call('saveQuestion', { scope: h.scope, expectedRevision: 3, expectedEvidenceRevision: 1, input: h.input })
  expect(created).toMatchObject({ ok: true, revision: 4 })
  if (!created.ok) throw Error(created.message)
  expect(await h.call('questionDetail', { scope: h.scope, questionId: created.question.id, page: 1 })).toMatchObject({ ok: true, revision: 4, question: created.question })
  expect(await h.call('archiveQuestion', { scope: h.scope, questionId: created.question.id, archived: true, expectedRevision: 3 })).toMatchObject({ ok: false, code: 'CONFLICT', currentRevision: 4 })
  expect(await h.call('listEvidence', { scope: h.scope, projectId: 'project-1', page: 0 })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
})
it('列表、素材写读、归档恢复和差异应用均通过固定接口闭环', async () => {
  const filter = { archive: 'exclude' }
  expect(await h.call('listQuestions', { scope: h.scope, filter, page: 1 })).toMatchObject({ ok: true, total: 2 })
  expect(await h.call('listEvidence', { scope: h.scope, projectId: 'project-1', page: 1 })).toMatchObject({ ok: true, total: 1 })
  expect(await h.call('listPacks', { scope: h.scope, filter, page: 1 })).toMatchObject({ ok: true, total: 1 })
  expect(await h.call('packDetail', { scope: h.scope, packId: h.saved.pack.id })).toMatchObject({ ok: true, pack: h.saved.pack })
  const items = h.saved.pack.versions[0]!.items.map(i => ({ kind: 'existing', itemId: i.id, section: i.section, note: i.note }))
  const saved = await h.call('savePack', { scope: h.scope, packId: h.saved.pack.id, expectedRevision: 3, input: { ...h.packInput, note: '桥接修改', items } })
  expect(saved).toMatchObject({ ok: true, revision: 4 })
  expect(await h.call('archivePack', { scope: h.scope, packId: h.saved.pack.id, expectedRevision: 4, archived: true })).toMatchObject({ ok: true, revision: 5 })
  expect(await h.call('archivePack', { scope: h.scope, packId: h.saved.pack.id, expectedRevision: 5, archived: false })).toMatchObject({ ok: true, revision: 6 })
  const request = { scope: h.scope, packId: h.saved.pack.id, itemIds: [h.saved.pack.versions[0]!.items[0]!.id], expectedRevision: 6, expectedEvidenceRevision: 1 }
  const preview = await h.call('previewRefresh', request)
  if (!preview.ok) throw Error(preview.message)
  expect(await h.call('applyRefresh', { ...request, previewToken: preview.previewToken })).toMatchObject({ ok: true, revision: 6 })
})
