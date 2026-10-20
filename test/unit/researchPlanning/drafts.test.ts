import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningDraftService } from '../../../electron/researchPlanning/drafts'
import { createPlanningService } from '../../../electron/researchPlanning/service'
import { emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-planning-draft-')); roots.push(root)
  let current = true
  const ctx = { scope: { id: 'space', epoch: 'epoch', root }, assertCurrent: () => { if (!current) throw Error('SPACE_CHANGED') } }
  return { root, ctx, drafts: createPlanningDraftService(ctx), invalidate: () => { current = false } }
}
it('恢复未命名和单端时间草稿，独立修订不改变正式数据，重新读取完整空白', () => {
  const { ctx, drafts } = setup()
  const input = { ...emptyPlanningInput('schedule'), content: ' \n正文\n\n', schedule: { date: '2026-10-21', start: '10:00', end: null } }
  drafts.save(0, { id: 'editing', itemId: null, baseRevision: 0, input })
  expect(createPlanningDraftService(ctx).list()).toMatchObject({ revision: 1, drafts: [{ input }] })
  expect(createPlanningService(ctx).bootstrap().revision).toBe(0)
})
it('过期修订、字段伪造与空间变化均不能覆盖已有草稿', () => {
  const { root, drafts, invalidate } = setup(), draft = { id: 'draft', itemId: null, baseRevision: 0, input: emptyPlanningInput('todo') }
  drafts.save(0, draft)
  const file = join(root, '.mimir/planning/drafts.json'), before = readFileSync(file)
  expect(() => drafts.save(0, draft)).toThrow()
  expect(() => drafts.save(1, { ...draft, path: 'C:/private' })).toThrow()
  invalidate(); expect(() => drafts.remove(1, 'draft')).toThrow(/SPACE_CHANGED/)
  expect(readFileSync(file)).toEqual(before)
})
it('显式丢弃仅移除所选草稿，失效修订不部分删除', () => {
  const { drafts } = setup(), input = emptyPlanningInput('generic')
  drafts.save(0, { id: 'a', itemId: null, baseRevision: 0, input })
  drafts.save(1, { id: 'b', itemId: null, baseRevision: 0, input })
  expect(() => drafts.remove(1, 'a')).toThrow()
  expect(drafts.list().drafts).toHaveLength(2)
  drafts.remove(2, 'a')
  expect(drafts.list().drafts.map(d => d.id)).toEqual(['b'])
})
