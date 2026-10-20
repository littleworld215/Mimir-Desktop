import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningService } from '../../../electron/researchPlanning/service'
import { emptyPlanningInput } from '../../../electron/researchPlanning/validation'

const roots: string[] = []
function setup() { const root = mkdtempSync(join(tmpdir(), 'mimir-planning-')); roots.push(root); return createPlanningService({ scope: { id: 's', epoch: 'e', root }, assertCurrent() {} }) }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
it('分组删除先预览迁移数量；取消不写，正式迁移不丢归档或回收站记录', () => {
  const s = setup(), group = s.mutate(0, { kind: 'collection', name: '课题分组' }).entityId!
  const a = s.save(1, { ...emptyPlanningInput('generic'), title: '记录', collectionId: group }).item
  s.mutate(2, { kind: 'bulk', ids: [a.id], patch: { deleted: true } })
  expect(s.mutate(3, { kind: 'collection', id: group, name: '课题分组', deleted: true, moveTo: 'default' }, true)).toMatchObject({ revision: 3, affectedCount: 1, preview: true })
  expect(s.bootstrap().collections.find(c => c.id === group)?.deleted).toBe(false)
  s.mutate(3, { kind: 'collection', id: group, name: '课题分组', deleted: true, moveTo: 'default' })
  expect(s.detail(a.id).item).toMatchObject({ collectionId: 'default', deleted: true })
})
it('自定义待办类型和记录复制；删除类型须同类型迁移，无效批量零部分写入', () => {
  const s = setup(), type = s.mutate(0, { kind: 'type', name: '阅读行动', itemKind: 'todo' }).entityId!
  const a = s.save(1, { ...emptyPlanningInput('todo'), title: '待办', typeId: type, fields: [{ id: 'f', name: '备注', value: '保留' }] }).item
  const copy = s.mutate(2, { kind: 'duplicate', id: a.id }).entityId!
  expect(copy).not.toBe(a.id)
  expect(s.detail(copy).item.fields[0]!.id).not.toBe('f')
  expect(() => s.mutate(3, { kind: 'type', id: type, name: '阅读行动', deleted: true, moveTo: 'generic' })).toThrow()
  expect(() => s.mutate(3, { kind: 'bulk', ids: [a.id, 'missing'], patch: { archived: true } })).toThrow()
  expect(s.detail(a.id).item.archived).toBe(false)
  s.mutate(3, { kind: 'type', id: type, name: '阅读行动', deleted: true, moveTo: 'todo' })
  expect(s.detail(a.id).item.typeId).toBe('todo')
})
it('同类型排序稳定；清空已完成可从回收站恢复且不处理别的类型', () => {
  const s = setup(), a = s.save(0, { ...emptyPlanningInput('todo'), title: '一', done: true }).item
  const b = s.save(1, { ...emptyPlanningInput('todo'), title: '二' }).item
  const c = s.save(2, { ...emptyPlanningInput('project'), title: '项目', status: 'done' }).item
  s.mutate(3, { kind: 'reorder', ids: [b.id, a.id] })
  expect(s.list({ kind: 'todo' }, 1).items.map(v => v.id)).toEqual([b.id, a.id])
  s.mutate(4, { kind: 'clearCompleted' })
  expect(s.detail(a.id).item.deleted).toBe(true)
  expect(s.detail(c.id).item.deleted).toBe(false)
  s.mutate(5, { kind: 'bulk', ids: [a.id], patch: { deleted: false } })
  expect(s.detail(a.id).item.deleted).toBe(false)
})
