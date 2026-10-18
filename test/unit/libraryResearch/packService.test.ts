import { afterEach, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archivePack, listPacks, packDetail, savePack } from '../../../electron/library/research/packService'
import { updateEvidence } from '../../../electron/library/evidence/service'
import { saveQuestion } from '../../../electron/library/research/questionService'
import { fields } from '../libraryEvidence/fixtures'
import { materialFixture } from './fixtures'
const fixtures: ReturnType<typeof materialFixture>[] = []
const setup = () => { const f = materialFixture(); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('fixedVersionsSurviveQuestionAndEvidenceEdits，保存只固定当时版本', () => {
  const f = setup(), before = readFileSync(join(f.root, '.mimir/library/evidence.json'))
  const p = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  expect(p.pack.versions[0]!.items).toHaveLength(2)
  expect(readFileSync(join(f.root, '.mimir/library/evidence.json'))).toEqual(before)
  updateEvidence(f.ctx, f.cards[0]!.id, { ...fields(), quote: '新版' }, 1)
  saveQuestion(f.ctx, { questionId: f.questions[0]!.id, input: { ...f.input, title: '改问题' }, expectedRevision: 3 })
  const view = packDetail(f.ctx, { packId: p.pack.id })
  expect(view.items[0]!.evidence!.quote).not.toBe('新版')
  expect(view.items[0]!.status.evidenceHasNewVersion).toBe(true)
  expect(view.items[0]!.status.questionHasNewVersion).toBe(true)
})
it('existingInputCannotRewritePinnedIds，新建同一旧引用也不能绕过差异更新', () => {
  const f = setup(), p = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  const i = p.pack.versions[0]!.items[0]!
  const existing = { kind: 'existing' as const, itemId: i.id, section: i.section, note: i.note }
  expect(() => savePack(f.ctx, { packId: p.pack.id, input: { ...f.packInput, items: [{ ...existing, evidenceVersion: 99 } as typeof existing] }, expectedRevision: 3 })).toThrow()
  expect(() => savePack(f.ctx, { packId: p.pack.id, input: f.packInput, expectedRevision: 3, expectedEvidenceRevision: 1 })).toThrow()
  expect(() => savePack(f.ctx, { input: { ...f.packInput, items: [f.packInput.items[0]!, f.packInput.items[0]!] }, expectedRevision: 3, expectedEvidenceRevision: 1 })).toThrow()
})
it('metadataRepairWorksWithUnreadableEvidence，固定条目可保留或移除并可归档', () => {
  const f = setup(), p = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  writeFileSync(join(f.root, '.mimir/library/evidence.json'), '{bad')
  const keep = p.pack.versions[0]!.items.map(i => ({ kind: 'existing' as const, itemId: i.id, section: i.section, note: i.note }))
  const a = savePack(f.ctx, { packId: p.pack.id, input: { ...f.packInput, note: '可修订', items: keep }, expectedRevision: 3 })
  expect(a.evidenceState).toBe('unreadable')
  const b = savePack(f.ctx, { packId: p.pack.id, input: { ...f.packInput, note: '可修订', items: keep }, expectedRevision: 4 })
  expect(b.revision).toBe(4)
  const c = archivePack(f.ctx, p.pack.id, true, 4)
  expect(c.pack.currentVersion).toBe(3)
  expect(packDetail(f.ctx, { packId: p.pack.id, version: 1 }).items[0]!.status.missingEvidence).toBe(true)
  expect(() => savePack(f.ctx, { packId: p.pack.id, input: { ...f.packInput, projectId: 'other', items: keep }, expectedRevision: 5 })).toThrow()
})
it('空素材包失去项目后仍显示异常，不能因没有条目误报健康', () => {
  const f = setup()
  savePack(f.ctx, { input: { ...f.packInput, items: [] }, expectedRevision: 2 })
  f.projects.splice(0)
  expect(listPacks(f.ctx, { archive: 'exclude' }, 1).items[0]!.problemCount).toBe(1)
})
