import { afterEach, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveQuestion, archiveQuestion } from '../../../electron/library/research/questionService'
import { readResearch } from '../../../electron/library/research/repository'
import { archiveEvidence, updateEvidence } from '../../../electron/library/evidence/service'
import { fields } from '../libraryEvidence/fixtures'
import { EvidenceError } from '../../../electron/library/evidence/validation'
import { researchFixture } from './fixtures'
const fixtures: ReturnType<typeof researchFixture>[] = []
const setup = (count = 1) => { const f = researchFixture(count); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))

it('oneCardManyQuestionsKeepsEvidenceBytes，同内容保存不增修订', () => {
  const f = setup(), path = join(f.root, '.mimir/library/evidence.json'), before = readFileSync(path)
  const a = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 1 })
  const b = saveQuestion(f.ctx, { input: { ...f.input, title: '另一个问题' }, expectedRevision: a.revision, expectedEvidenceRevision: 1 })
  const same = saveQuestion(f.ctx, { questionId: a.question.id, input: f.input, expectedRevision: b.revision })
  expect(same.revision).toBe(b.revision)
  expect(readResearch(f.root).questions).toHaveLength(2)
  expect(readFileSync(path)).toEqual(before)
})
it('cannotAddArchivedOrOtherProjectCard，过期修订拒绝', () => {
  const f = setup(), card = f.cards[0]!
  archiveEvidence(f.ctx, card.id, true, 1)
  expect(() => saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 1 })).toThrow(/CONFLICT/)
  expect(() => saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 2 })).toThrow()
  updateEvidence(f.ctx, card.id, { ...fields(), projectIds: [] }, 2)
  archiveEvidence(f.ctx, card.id, false, 3)
  expect(() => saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 4 })).toThrow()
  expect(readResearch(f.root).revision).toBe(0)
})
it('removeBrokenLinkAndEditNoteStillAllowed，删除后不能重新加回失效关联', () => {
  const f = setup(), a = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 1 })
  archiveEvidence(f.ctx, f.cards[0]!.id, true, 1)
  const b = saveQuestion(f.ctx, { questionId: a.question.id, input: { ...f.input, note: '仍保留原关联' }, expectedRevision: 1 })
  expect(b.question.currentVersion).toBe(2)
  const c = saveQuestion(f.ctx, { questionId: a.question.id, input: { ...f.input, note: '移除', evidenceCardIds: [] }, expectedRevision: 2 })
  expect(c.question.versions[2]!.evidenceCardIds).toEqual([])
  expect(() => saveQuestion(f.ctx, { questionId: a.question.id, input: f.input, expectedRevision: 3, expectedEvidenceRevision: 2 })).toThrow()
})
it('损坏证据也可保存元数据/移除/归档，但不能新增引用或更换项目', () => {
  const f = setup(), a = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 1 })
  writeFileSync(join(f.root, '.mimir/library/evidence.json'), '{bad')
  const b = saveQuestion(f.ctx, { questionId: a.question.id, input: { ...f.input, note: '元数据' }, expectedRevision: 1 })
  expect(b.evidenceState).toBe('unreadable')
  expect(b.evidenceRevision).toBeNull()
  expect(() => saveQuestion(f.ctx, { questionId: a.question.id, input: { ...f.input, projectId: 'other' }, expectedRevision: 2 })).toThrow()
  const archived = archiveQuestion(f.ctx, a.question.id, true, 2)
  expect(archived.question.versions.at(-1)!.archived).toBe(true)
  expect(archiveQuestion(f.ctx, a.question.id, true, 3).revision).toBe(3)
})
it('deletedProject保留组且只能保留/移除旧关联；发布前再次确认上下文', () => {
  const f = setup(), a = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 1 })
  f.projects.splice(0)
  expect(saveQuestion(f.ctx, { questionId: a.question.id, input: { ...f.input, evidenceCardIds: [] }, expectedRevision: 1 }).revision).toBe(2)
  expect(() => saveQuestion(f.ctx, { input: { ...f.input, evidenceCardIds: [] }, expectedRevision: 2 })).toThrow()
  let calls = 0
  f.ctx.assertCurrent = () => { if (++calls > 1) throw new EvidenceError('SPACE_CHANGED') }
  expect(() => archiveQuestion(f.ctx, a.question.id, true, 2)).toThrow(/SPACE_CHANGED/)
  expect(readResearch(f.root).revision).toBe(2)
})
