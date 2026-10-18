import { afterEach, expect, it } from 'vitest'
import { applyPackRefresh, packDetail, previewPackRefresh, savePack } from '../../../electron/library/research/packService'
import { updateEvidence } from '../../../electron/library/evidence/service'
import { saveQuestion } from '../../../electron/library/research/questionService'
import { fields } from '../libraryEvidence/fixtures'
import { materialFixture } from './fixtures'
const fixtures: ReturnType<typeof materialFixture>[] = []
const setup = () => { const f = materialFixture(); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('nonSelectedItemsNeverAdvance，差异包含完整旧新摘录且token防旧预览', () => {
  const f = setup(), p = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  const items = p.pack.versions[0]!.items
  updateEvidence(f.ctx, f.cards[0]!.id, { ...fields(), quote: '新版全文😀\n' }, 1)
  const request = { packId: p.pack.id, itemIds: [items[0]!.id], expectedRevision: 3, expectedEvidenceRevision: 2 }
  const preview = previewPackRefresh(f.ctx, request)
  expect(preview.changes[0]!.before.evidence!.quote).not.toBe('新版全文😀\n')
  expect(preview.changes[0]!.after!.evidence!.quote).toBe('新版全文😀\n')
  expect(() => applyPackRefresh(f.ctx, { ...request, previewToken: '0'.repeat(64) })).toThrow(/CONFLICT/)
  const updated = applyPackRefresh(f.ctx, { ...request, previewToken: preview.previewToken })
  expect(updated.pack.currentVersion).toBe(2)
  const view = packDetail(f.ctx, { packId: p.pack.id })
  expect(view.items.map(i => i.item.evidenceVersion)).toEqual([2, 1])
  expect(packDetail(f.ctx, { packId: p.pack.id, version: 1 }).items.map(i => i.item.evidenceVersion)).toEqual([1, 1])
})
it('refreshRemovedFromQuestionIsBlocked，并拒绝重复或不存在的条目', () => {
  const f = setup(), p = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  const id = p.pack.versions[0]!.items[0]!.id
  saveQuestion(f.ctx, { questionId: f.questions[0]!.id, input: { ...f.input, evidenceCardIds: [] }, expectedRevision: 3 })
  const request = { packId: p.pack.id, itemIds: [id], expectedRevision: 4, expectedEvidenceRevision: 1 }
  const preview = previewPackRefresh(f.ctx, request)
  expect(preview.changes[0]!.eligible).toBe(false)
  expect(() => applyPackRefresh(f.ctx, { ...request, previewToken: preview.previewToken })).toThrow()
  expect(() => previewPackRefresh(f.ctx, { ...request, itemIds: [id, id] })).toThrow()
  expect(packDetail(f.ctx, { packId: p.pack.id }).pack.currentVersion).toBe(1)
})
it('固定旧版本的来源状态不借用当前版本的检查结果', () => {
  const f = setup(), p = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  const id = f.cards[0]!.id
  updateEvidence(f.ctx, id, { ...fields(), quote: '新版' }, 1)
  f.observations.set(`${id}:1`, { status: 'changed' })
  f.observations.set(`${id}:2`, { status: 'available' })
  expect(packDetail(f.ctx, { packId: p.pack.id }).items[0]!.sourceStatus).toBe('changed')
})
