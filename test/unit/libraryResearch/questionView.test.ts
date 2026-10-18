import { afterEach, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveQuestion } from '../../../electron/library/research/questionService'
import { listEvidence, listQuestions, questionDetail } from '../../../electron/library/research/questionView'
import { researchFixture } from './fixtures'
import { updateEvidence } from '../../../electron/library/evidence/service'
import { fields } from '../libraryEvidence/fixtures'
const fixtures: ReturnType<typeof researchFixture>[] = []
const setup = (count = 1) => { const f = researchFixture(count); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))

it('filterBeforeCardPaging：同文献51卡按卡分页，完整正文尾部关键词可命中', () => {
  const f = setup(51)
  const all = listEvidence(f.ctx, { projectId: 'project-1', page: 1 })
  expect(all.total).toBe(51); expect(all.items).toHaveLength(50)
  expect(listEvidence(f.ctx, { projectId: 'project-1', page: 2 }).items).toHaveLength(1)
  const match = listEvidence(f.ctx, { projectId: 'project-1', page: 1, keyword: '尾部命中' })
  expect(match.total).toBe(1); expect(match.items[0]!.cardId).toBe(f.cards[50]!.id)
  expect(Array.from(match.items[0]!.quote)).toHaveLength(200)
})
it('比较默认保留所有关系并在分页前计算计数，历史视图不冒充当前分组', () => {
  const f = setup(51)
  const relations = ['supports', 'opposes', 'mixed', 'unassessed'] as const
  relations.forEach((relation, i) => updateEvidence(f.ctx, f.cards[i]!.id, { ...fields(), relation }, 51 + i))
  const q = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 55 })
  const detail = questionDetail(f.ctx, { questionId: q.question.id, page: 1 })
  expect(detail.total).toBe(51); expect(detail.rows).toHaveLength(50)
  expect(detail.relationCounts).toEqual({ supports: 1, opposes: 1, mixed: 1, unassessed: 48, unknown: 0 })
  saveQuestion(f.ctx, { questionId: q.question.id, input: { ...f.input, evidenceCardIds: [] }, expectedRevision: 1 })
  expect(questionDetail(f.ctx, { questionId: q.question.id, page: 1 }).total).toBe(0)
  expect(questionDetail(f.ctx, { questionId: q.question.id, version: 1, page: 1 }).total).toBe(51)
})
it('deletedProjectRemainsVisibleInAllScope，损坏证据不能伪造异常数为0', () => {
  const f = setup(), q = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 1 })
  f.projects.splice(0)
  expect(listQuestions(f.ctx, { archive: 'exclude' }, 1).items[0]!.problemCount).toBeGreaterThan(0)
  expect(questionDetail(f.ctx, { questionId: q.question.id, page: 1 }).rows[0]!.problems).toContain('项目已移除')
  writeFileSync(join(f.root, '.mimir/library/evidence.json'), '{bad')
  expect(listQuestions(f.ctx, { archive: 'exclude' }, 1).items[0]!.problemCount).toBeNull()
  const broken = questionDetail(f.ctx, { questionId: q.question.id, page: 1 })
  expect(broken.rows[0]!.version).toBeNull(); expect(broken.relationCounts.unknown).toBe(1)
  expect(listQuestions(f.ctx, { archive: 'exclude' }, 100).items).toEqual([])
})
it('来源文献移除也计入问题异常数，不能仅计算项目和归档异常', () => {
  const f = setup(), q = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 1 })
  f.papers.splice(0)
  expect(listQuestions(f.ctx, { archive: 'exclude' }, 1).items[0]!.problemCount).toBe(1)
  const detail = questionDetail(f.ctx, { questionId: q.question.id, page: 1 })
  expect(detail.rows[0]!.sourceStatus).toBe('detached')
  expect(detail.rows[0]!.problems).toContain('来源文献已移除')
})
it('单次比较使用同一来源观察快照，不能逐行重新克隆全部观察', () => {
  const f = setup(4), q = saveQuestion(f.ctx, { input: f.input, expectedRevision: 0, expectedEvidenceRevision: 4 })
  let reads = 0
  f.ctx.sourceObservations = () => { reads++; return new Map() }
  questionDetail(f.ctx, { questionId: q.question.id, page: 1 })
  expect(reads).toBe(1)
})
