import { expect, it } from 'vitest'
import { decodePlanningExchange, mergePlanningExchange, serializePlanningExchange } from '../../../electron/researchPlanning/exchange'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

const stamp = '2026-10-21T00:00:00.000Z'
function foreign(version: 1 | 2) {
  const base = { typeId: 'todo', workspaceId: 'group', content: '\n  原文\n\n', status: 'active', starred: true, archived: false, fields: [], priority: 'high', dueDate: '2026-10-21', done: false, planDate: null, planStart: null, planEnd: null, createdAt: Date.parse(stamp), updatedAt: Date.parse(stamp) }
  return { app: 'research-workbench', version, exportedAt: stamp, types: [{ id: 'todo', name: '待办', kind: 'todo', icon: 'list', note: '♪', builtin: true }, { id: 'project', name: '项目', kind: 'project', icon: 'folder', note: '♫', builtin: true }], workspaces: [{ id: 'group', name: '导入分组', builtin: true }], records: [{ ...base, id: 'project', typeId: 'project', title: '课题' }, { ...base, id: 'todo', title: '阅读', ...(version === 2 ? { projectId: 'project', recurrence: { frequency: 'weekly', interval: 2 }, literature: null } : {}) }], ...(version === 2 ? { settings: { autoLaunch: true, notificationsEnabled: true } } : {}) }
}
it.each([1, 2] as const)('v%s显式适配分组与类型，关系重映射、原文不改，外部设置不生效', version => {
  const source = decodePlanningExchange(JSON.stringify(foreign(version)))
  const result = mergePlanningExchange(emptyPlanningDocument(), source.document, { strategy: 'skip', collections: {} })
  expect(result.document.items).toHaveLength(2)
  const todo = result.document.items.find(i => i.title === '阅读')!
  expect(todo.content).toBe('\n  原文\n\n'); expect(todo.myDay).toBeNull(); expect(todo.important).toBe(true)
  if (version === 2) {
    expect(todo.projectId).toBe(result.document.items.find(i => i.title === '课题')!.id)
    expect(todo.recurrence).toEqual({ unit: 'weekly', interval: 2 })
  }
  expect(result.document).not.toHaveProperty('settings')
})
it('重复导入默认跳过，可明确副本或更新；更新保留身份，分组映射生效', () => {
  const source = decodePlanningExchange(JSON.stringify(foreign(2))).document
  const first = mergePlanningExchange(emptyPlanningDocument(), source, { strategy: 'skip', collections: { [source.collections[0]!.id]: 'default' } }).document
  expect(first.items.every(i => i.collectionId === 'default')).toBe(true)
  const skipped = mergePlanningExchange(first, source, { strategy: 'skip', collections: {} })
  expect(skipped.document.items).toHaveLength(2); expect(skipped.counts.skipped).toBe(2)
  const copied = mergePlanningExchange(first, source, { strategy: 'copy', collections: {} }).document
  expect(copied.items).toHaveLength(4)
  const child = copied.items.at(-1)!, parent = copied.items.at(-2)!
  expect(child.projectId).toBe(parent.id)
  const changed = structuredClone(source); changed.items[0]!.title = '新版课题'
  const updated = mergePlanningExchange(first, changed, { strategy: 'update', collections: {} }).document
  expect(updated.items[0]!.title).toBe('新版课题'); expect(updated.items[0]!.id).toBe(first.items[0]!.id)
  expect(updated.items[0]!.createdAt).toBe(first.items[0]!.createdAt)
})
it('任一非法日期、重复标识、失效类型或较新格式整份拒绝，不改变原对象', () => {
  const source = foreign(2), before = JSON.stringify(source)
  for (const bad of [{ ...source, version: 3 }, { ...source, records: [...source.records, source.records[0]] }, { ...source, records: [{ ...source.records[0], dueDate: '2026-02-30' }] }, { ...source, records: [{ ...source.records[0], typeId: 'missing' }] }]) expect(() => decodePlanningExchange(JSON.stringify(bad))).toThrow()
  expect(JSON.stringify(source)).toBe(before)
})
it('合法的原型同名分组标识不会从空映射读取继承属性', () => {
  const source = emptyPlanningDocument(); source.collections[0]!.id = 'constructor'
  expect(() => mergePlanningExchange(emptyPlanningDocument(), source, { strategy: 'skip', collections: {} })).not.toThrow()
})
it('来源记录的类型发生变化时仍可显式保留副本，不修改原记录类型', () => {
  const current = emptyPlanningDocument(), incoming = emptyPlanningDocument()
  const record = { ...emptyPlanningInput('generic'), id: 'record', title: '原记录', createdAt: stamp, updatedAt: stamp }
  current.items = [record]
  incoming.items = [{ ...record, ...emptyPlanningInput('literature'), title: '带书目资料的新记录' }]
  expect(() => mergePlanningExchange(current, incoming, { strategy: 'update', collections: {} })).toThrow()
  const copied = mergePlanningExchange(current, incoming, { strategy: 'copy', collections: {} })
  expect(copied.document.items.map(i => i.kind)).toEqual(['generic', 'literature'])
  expect(copied.document.items[0]).toEqual(record)
})
it('四种导出保留完整字段，JSON可回读，HTML不执行正文，CSV阻断公式', () => {
  const document = emptyPlanningDocument()
  document.items = [{ ...emptyPlanningInput('generic'), id: 'record', title: '=1+1', content: '<img src="https://example.test/a"><script>alert(1)</script>\n\n  原文\n', createdAt: stamp, updatedAt: stamp }]
  const json = serializePlanningExchange(document, 'json')
  expect(decodePlanningExchange(json).document).toEqual(document)
  expect(serializePlanningExchange(document, 'markdown')).toContain(document.items[0]!.content)
  expect(serializePlanningExchange(document, 'html')).not.toMatch(/<img |<script>/)
  expect(serializePlanningExchange(document, 'html')).toContain('&lt;script&gt;')
  expect(serializePlanningExchange(document, 'csv')).toContain("'=1+1")
  document.items[0]!.title = '\u00a0=2+2'
  expect(serializePlanningExchange(document, 'csv')).toContain("'\u00a0=2+2")
})
