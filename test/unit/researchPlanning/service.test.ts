import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningService } from '../../../electron/researchPlanning/service'
import { emptyPlanningInput } from '../../../electron/researchPlanning/validation'
import { createPlanningRepository, createPlanningDraftRepository, createPlanningDeliveryRepository } from '../../../electron/researchPlanning/repository'

const roots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-planning-')); roots.push(root)
  let current = true
  const ctx = { scope: { id: 'space', epoch: 'generation', root }, assertCurrent: () => { if (!current) throw Error('SPACE_CHANGED') } }
  return { root, service: createPlanningService(ctx), invalidate: () => { current = false } }
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
it('新增项目和独立人工待办，保留多行正文及空白字段，过期保存失败', () => {
  const { service } = setup()
  const project = service.save(0, { ...emptyPlanningInput('project'), title: '科研项目' })
  const todo = service.save(1, { ...emptyPlanningInput('todo'), title: '阅读', projectId: project.item.id, content: '正文\n\n  保留空白\n', fields: [{ id: 'field', name: '备注', value: '' }] })
  expect(service.detail(todo.item.id).item.content).toBe('正文\n\n  保留空白\n')
  expect(() => service.save(1, { ...todo.item, title: '过期' }, todo.item.id)).toThrow()
  expect(service.detail(todo.item.id).item.title).toBe('阅读')
})
it('任意非法类型/日期/项目关联拒绝保存且无部分写入', () => {
  const { root, service } = setup(), input = { ...emptyPlanningInput('todo'), title: '待办' }
  for (const invalid of [{ ...input, typeId: 'project' }, { ...input, dueDate: '2026-02-30' }, { ...input, projectId: 'missing' }, { ...input, recurrence: { unit: 'daily', interval: 1 } }]) expect(() => service.save(0, invalid)).toThrow()
  expect(createPlanningRepository().read(root).revision).toBe(0)
})
it('分页、全文字段及组合筛选；回收站记录默认不可见但能恢复', () => {
  const { service } = setup()
  for (let i = 0; i < 51; i++) service.save(i, { ...emptyPlanningInput('generic'), title: `记录${i}`, content: '摘要', fields: [{ id: 'f', name: '实验', value: '关键字' }], important: i === 0 })
  expect(service.list({}, 1).items).toHaveLength(50)
  expect(service.list({}, 2).items).toHaveLength(1)
  expect(service.list({ keyword: '关键字', important: true }, 1).total).toBe(1)
  const first = service.list({}, 1).items[0]!
  const { id, createdAt, updatedAt, ...input } = first
  service.save(51, { ...input, deleted: true }, id)
  expect(service.list({}, 1).total).toBe(50)
  expect(service.list({ deleted: true }, 1).total).toBe(1)
  service.save(52, input, id)
  expect(service.list({}, 1).total).toBe(51)
})
it('草稿和提醒各自修订不会改变正式数据；空间已变化拒绝旧请求', () => {
  const { root, service, invalidate } = setup()
  const drafts = createPlanningDraftRepository(), deliveries = createPlanningDeliveryRepository()
  drafts.commit(root, 0, { schemaVersion: 1, revision: 1, drafts: [] })
  deliveries.commit(root, 0, { schemaVersion: 1, revision: 1, deliveries: [] })
  expect(service.bootstrap().revision).toBe(0)
  invalidate()
  expect(() => service.save(0, { ...emptyPlanningInput('todo'), title: '错误空间' })).toThrow(/SPACE_CHANGED/)
  expect(createPlanningRepository().read(root).items).toEqual([])
})
it('未命名或起止时间未填完也能恢复草稿，不冒充已保存日程', () => {
  const { root, service } = setup(), drafts = createPlanningDraftRepository()
  const input = { ...emptyPlanningInput('schedule'), schedule: { date: '2026-10-20', start: '10:00', end: null } }
  drafts.commit(root, 0, { schemaVersion: 1, revision: 1, drafts: [{ id: 'new', itemId: null, baseRevision: 0, input, updatedAt: new Date().toISOString() }] })
  expect(drafts.read(root).drafts[0]!.input).toEqual(input)
  expect(service.bootstrap().total).toBe(0)
  expect(() => service.save(0, input)).toThrow()
})
