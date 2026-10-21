import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { createPlanningRuntime } from '../../../electron/researchPlanning/runtime'
import { createPlanningService } from '../../../electron/researchPlanning/service'
import { createPlanningRepository, createPlanningDeliveryRepository } from '../../../electron/researchPlanning/repository'
import { emptyPlanningInput } from '../../../electron/researchPlanning/validation'
import { createPlanningReminders } from '../../../electron/researchPlanning/reminders'

const roots: string[] = []
const controllers: ReturnType<typeof createPlanningReminders>[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(c => c.stop())); vi.useRealTimers(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-reminder-')); roots.push(root)
  let scope = { id: 'one', epoch: 'first', root }, enabled = true
  const gate = new WorkspaceOperationGate(), runtime = createPlanningRuntime({ gate, capture: () => scope })
  const shown: { itemId: string; onClick(): void }[] = [], opened: string[] = []
  let show = async (value: { itemId: string; onClick(): void }, _signal: AbortSignal) => { shown.push(value); return true }
  const controller = createPlanningReminders({ runtime, enabled: () => enabled, today: () => '2026-10-21', now: () => new Date('2026-10-21T12:00:00Z'), show: (value, signal) => show(value, signal), closeAll: vi.fn(), open: (_scope, id) => { opened.push(id) } })
  controllers.push(controller)
  const add = (name: string, patch = {}) => { const service = createPlanningService({ scope, assertCurrent() {} }); return service.save(service.bootstrap().revision, { ...emptyPlanningInput('todo'), title: name, dueDate: '2026-10-21', ...patch }).item }
  return { root, gate, runtime, controller, shown, opened, add, enable: (v: boolean) => { enabled = v }, presenter: (fn: typeof show) => { show = fn }, change: () => { scope = { ...scope, id: 'two', epoch: 'second' } } }
}
it('关闭时不创建任何计划目录；所有待办类型均可提醒，成功后按记录与到期日持久去重', async () => {
  const f = setup(); f.enable(false); await f.controller.check(); expect(existsSync(join(f.root, '.mimir'))).toBe(false)
  const custom = createPlanningRepository(), doc = custom.read(f.root)
  custom.commit(f.root, 0, { ...doc, revision: 1, types: [...doc.types, { id: 'custom-todo', name: '自定义待办', kind: 'todo', builtin: false, order: 1, deleted: false }] })
  const first = f.add('今天'), second = f.add('另一个类型', { typeId: 'custom-todo' })
  f.add('未来', { dueDate: '2026-10-22' }); f.add('完成', { done: true }); f.add('归档', { archived: true }); f.add('回收站', { deleted: true })
  f.enable(true); await f.controller.check(); await f.controller.check()
  expect(f.shown.map(v => v.itemId).sort()).toEqual([first.id, second.id].sort())
  expect(createPlanningDeliveryRepository().read(f.root).deliveries).toHaveLength(2)
})
it('通知失败不记已送达，下轮可重试；成功前修改到期日不记旧结果', async () => {
  const f = setup(), item = f.add('失败可重试')
  f.presenter(async () => false); await f.controller.check(); expect(createPlanningDeliveryRepository().read(f.root).deliveries).toEqual([])
  f.presenter(async () => { const doc = createPlanningRepository().read(f.root); createPlanningRepository().commit(f.root, doc.revision, { ...doc, revision: doc.revision + 1, items: doc.items.map(i => ({ ...i, dueDate: '2026-11-01' })) }); return true })
  await f.controller.check(); expect(createPlanningDeliveryRepository().read(f.root).deliveries).toEqual([])
  expect(item.id).toBeTruthy()
})
it('一次最多五条成功通知，按类型轮转覆盖；不丢弃积压且重启读取去重', async () => {
  const f = setup(), repo = createPlanningRepository(), doc = repo.read(f.root)
  repo.commit(f.root, 0, { ...doc, revision: 1, types: [...doc.types, { id: 'other', name: '另一类型', kind: 'todo', builtin: false, order: 1, deleted: false }] })
  for (let i = 0; i < 8; i++) f.add(`默认${i}`)
  const other = f.add('另一类型', { typeId: 'other' })
  await f.controller.check(); expect(f.shown).toHaveLength(5); expect(f.shown.some(v => v.itemId === other.id)).toBe(true)
  await f.controller.check(); expect(f.shown).toHaveLength(9)
  expect(createPlanningDeliveryRepository().read(f.root).deliveries).toHaveLength(9)
})
it('停用和排空等待忽略取消的通知真正完成，不记录已取消结果，不把主动取消当排空失败', async () => {
  const f = setup(); f.add('受管任务')
  let release!: () => void, entered!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  f.presenter(async () => { entered(); await hold; return true })
  const checking = f.controller.check(); await ready
  f.gate.stopAccepting(); let stopped = false
  const stop = f.controller.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false); expect(f.gate.pendingCount).toBe(1)
  release(); await checking; await stop; await f.gate.drain(1000)
  expect(createPlanningDeliveryRepository().read(f.root).deliveries).toEqual([])
})
it('通知点击重读当前记录，禁止旧空间、已删除或停用后的点击跳转', async () => {
  const f = setup(), item = f.add('点击'); await f.controller.check()
  f.shown[0].onClick(); await vi.waitFor(() => expect(f.opened).toEqual([item.id]))
  f.change(); f.shown[0].onClick(); await new Promise(resolve => setTimeout(resolve, 10)); expect(f.opened).toEqual([item.id])
  await f.controller.stop(); f.shown[0].onClick(); expect(f.opened).toHaveLength(1)
})
it('启动及十五分钟检查可停，默认关闭不启动计时检查', async () => {
  vi.useFakeTimers(); const f = setup(); f.enable(false); f.controller.refresh(); await vi.advanceTimersByTimeAsync(900_001); expect(f.shown).toHaveLength(0)
  f.add('定时'); f.enable(true); f.controller.refresh(); await vi.advanceTimersByTimeAsync(1); expect(f.shown).toHaveLength(1)
  f.add('下一轮'); await vi.advanceTimersByTimeAsync(900_000); expect(f.shown).toHaveLength(2)
  await f.controller.stop(); f.add('停止后'); await vi.advanceTimersByTimeAsync(900_000); expect(f.shown).toHaveLength(2)
})
