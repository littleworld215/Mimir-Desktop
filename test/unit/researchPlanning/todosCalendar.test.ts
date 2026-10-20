import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningService } from '../../../electron/researchPlanning/service'
import { emptyPlanningInput } from '../../../shared/researchPlanningDefaults'
const roots: string[] = []
function setup() { const root = mkdtempSync(join(tmpdir(), 'mimir-planning-')); roots.push(root); return createPlanningService({ scope: { id: 's', epoch: 'e', root }, assertCurrent() {}, today: () => '2026-10-20' }) }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
it('完成周期待办与下一期同一修订提交；重试、撤销再完成均不重复生成', () => {
  const s = setup(), item = s.save(0, { ...emptyPlanningInput('todo'), title: '每日阅读', dueDate: '2026-10-01', recurrence: { unit: 'daily', interval: 1 }, myDay: '2026-10-20' }).item
  s.mutate(1, { kind: 'completeTodo', id: item.id, done: true })
  const next = s.list({ kind: 'todo', done: false }, 1).items[0]!
  expect(next).toMatchObject({ dueDate: '2026-10-21', myDay: null, recurrenceParentId: item.id })
  expect(s.bootstrap().revision).toBe(2)
  s.mutate(2, { kind: 'completeTodo', id: item.id, done: true })
  s.mutate(3, { kind: 'completeTodo', id: item.id, done: false })
  s.mutate(4, { kind: 'completeTodo', id: item.id, done: true })
  expect(s.list({ kind: 'todo' }, 1).total).toBe(2)
})
it('我的一天显式选择，与截止/逾期和完成状态分开；编辑器完成同样生成下一期', () => {
  const s = setup(), item = s.save(0, { ...emptyPlanningInput('todo'), title: '已到期但未选入今天', dueDate: '2026-10-19', recurrence: { unit: 'weekly', interval: 1 } }).item
  expect(s.list({ myDay: '2026-10-20' }, 1).total).toBe(0)
  expect(s.list({ dueBefore: '2026-10-20' }, 1).total).toBe(1)
  const { id, createdAt, updatedAt, ...input } = item
  s.save(1, { ...input, done: true, status: 'done' }, id)
  expect(s.list({ kind: 'todo' }, 1).total).toBe(2)
  expect(s.detail(id).item.done).toBe(true)
})
it('日程范围按日期聚合准确总数及前三项；选中日正文仍独立分页读取', () => {
  const s = setup()
  for (let i = 0; i < 4; i++) s.save(i, { ...emptyPlanningInput('schedule'), title: `日程${i}`, schedule: { date: '2026-10-20', start: '10:00', end: '11:00' } })
  s.save(4, { ...emptyPlanningInput('schedule'), title: '范围外', schedule: { date: '2026-11-20', start: null, end: null } })
  const calendar = s.calendar('2026-10-19', '2026-10-25')
  expect(calendar.days.find(d => d.date === '2026-10-20')).toMatchObject({ total: 4 })
  expect(calendar.days.find(d => d.date === '2026-10-20')!.items).toHaveLength(3)
  expect(calendar.total).toBe(4)
  expect(s.list({ kind: 'schedule', dateFrom: '2026-10-20', dateTo: '2026-10-20' }, 1).total).toBe(4)
  expect(() => s.calendar('2026-01-01', '2026-12-31')).toThrow()
})
it('总览按当前空间统计；项目下一步只取未归档未完成待办且优先级明确', () => {
  const s = setup(), project = s.save(0, { ...emptyPlanningInput('project'), title: '课题' }).item
  s.save(1, { ...emptyPlanningInput('todo'), title: '下一步', projectId: project.id, myDay: '2026-10-20', dueDate: '2026-10-19', priority: 'high' })
  s.save(2, { ...emptyPlanningInput('todo'), title: '已完成', projectId: project.id, done: true, status: 'done' })
  const summary = s.summary('2026-10-20', [project.id])
  expect(summary.counts).toMatchObject({ myDay: 1, overdue: 1, activeProjects: 1 })
  expect(summary.nextActions[project.id]?.map(i => i.title)).toEqual(['下一步'])
})
it('日历计数尊重分组及归档筛选，不混入其它分组或遗漏已归档条目', () => {
  const s = setup(), group = s.mutate(0, { kind: 'collection', name: '其它分组' }).entityId!
  const event = { ...emptyPlanningInput('schedule'), title: '日程', schedule: { date: '2026-10-20', start: null, end: null } }
  s.save(1, event); s.save(2, { ...event, collectionId: group }); s.save(3, { ...event, archived: true })
  expect(s.calendar('2026-10-19', '2026-10-25', { collectionId: 'default' }).total).toBe(1)
  expect(s.calendar('2026-10-19', '2026-10-25', { collectionId: 'default', archived: 'only' }).total).toBe(1)
})
