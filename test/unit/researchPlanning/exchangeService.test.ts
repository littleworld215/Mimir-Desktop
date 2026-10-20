import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningExchangeService } from '../../../electron/researchPlanning/exchangeService'
import { serializePlanningExchange } from '../../../electron/researchPlanning/exchange'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'
import { createPlanningService } from '../../../electron/researchPlanning/service'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-planning-exchange-')); roots.push(root)
  const ctx = { scope: { id: 'space', epoch: 'epoch', root }, assertCurrent() {} }
  const source = emptyPlanningDocument()
  source.items.push({ ...emptyPlanningInput('generic'), title: '合成导入', content: '\n  原文\n', id: 'incoming', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' })
  return { ctx, root, bytes: Buffer.from(serializePlanningExchange(source, 'json')), exchange: createPlanningExchangeService() }
}
it('选入快照不写业务，预览后一次提交；重放令牌或另一窗口不能再次应用', () => {
  const { ctx, root, bytes, exchange } = setup()
  const selection = exchange.select(ctx, 1, 'synthetic.json', bytes)
  const preview = exchange.preview(ctx, 1, selection.importId, 0, { strategy: 'skip', collections: {} })
  expect(existsSync(join(root, '.mimir/planning/planning.json'))).toBe(false)
  expect(() => exchange.apply(ctx, 2, selection.importId, preview.previewToken, 0)).toThrow()
  exchange.apply(ctx, 1, selection.importId, preview.previewToken, 0)
  expect(createPlanningService(ctx).list({}, 1).items[0]!.content).toBe('\n  原文\n')
  expect(() => exchange.apply(ctx, 1, selection.importId, preview.previewToken, 1)).toThrow()
})
it('预览后业务变更、空间代际变化均阻止提交，不部分写入', () => {
  const { ctx, root, bytes, exchange } = setup(), selection = exchange.select(ctx, 1, 'synthetic.json', bytes)
  const preview = exchange.preview(ctx, 1, selection.importId, 0, { strategy: 'skip', collections: {} })
  createPlanningService(ctx).save(0, { ...emptyPlanningInput('project'), title: '预览后变化' })
  const file = join(root, '.mimir/planning/planning.json'), before = readFileSync(file)
  expect(() => exchange.apply(ctx, 1, selection.importId, preview.previewToken, 0)).toThrow()
  ctx.scope.epoch = 'another'
  expect(() => exchange.preview(ctx, 1, selection.importId, 1, { strategy: 'skip', collections: {} })).toThrow()
  expect(readFileSync(file)).toEqual(before)
})
it('导出预览固定完整内容，时间变化不重建；业务变化和失效令牌不能保存', () => {
  const { ctx, exchange } = setup()
  createPlanningService(ctx).save(0, { ...emptyPlanningInput('generic'), title: '导出原文', content: '\n正文\n' })
  const preview = exchange.exportPreview(ctx, 1, 1, 'json')
  const payload = exchange.exportPayload(ctx, 1, preview.previewToken, 1)
  expect(JSON.parse(payload.bytes.toString()).document.items[0].content).toBe('\n正文\n')
  expect(exchange.exportPayload(ctx, 1, preview.previewToken, 1).bytes).toEqual(payload.bytes)
  createPlanningService(ctx).save(1, { ...emptyPlanningInput('generic'), title: '后续变化' })
  expect(() => exchange.exportPayload(ctx, 1, preview.previewToken, 1)).toThrow()
})
it('重复项预览提供具体条目及完整原文对照，查看不会修改记录', () => {
  const { ctx, root, bytes, exchange } = setup()
  const first = exchange.select(ctx, 1, 'first.json', bytes), options = { strategy: 'update' as const, collections: {} }
  const initial = exchange.preview(ctx, 1, first.importId, 0, options)
  exchange.apply(ctx, 1, first.importId, initial.previewToken, 0)
  const changed = JSON.parse(bytes.toString()); changed.document.items[0].title = '改变标题'; changed.document.items[0].content = '\n  新版原文\n'
  const selected = exchange.select(ctx, 1, 'second.json', Buffer.from(JSON.stringify(changed)))
  const preview = exchange.preview(ctx, 1, selected.importId, 1, options)
  expect(preview.duplicates).toMatchObject([{ id: 'incoming', before: { title: '合成导入' }, incoming: { title: '改变标题' }, bodyChanged: true }])
  const file = join(root, '.mimir/planning/planning.json'), before = readFileSync(file)
  const difference = exchange.difference(ctx, 1, selected.importId, preview.previewToken, 1, 'incoming')
  expect(difference.before.content).toBe('\n  原文\n'); expect(difference.incoming.content).toBe('\n  新版原文\n')
  expect(() => exchange.difference(ctx, 1, selected.importId, 'wrong', 1, 'incoming')).toThrow()
  expect(readFileSync(file)).toEqual(before)
})
