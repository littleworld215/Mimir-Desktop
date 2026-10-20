import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PLANNING_CHANNELS, type PlanningExportFormat } from '../../shared/researchPlanningContracts'
import { planningRuntime, type PlanningRuntime } from '../researchPlanning/runtime'
import { createPlanningService } from '../researchPlanning/service'
import { createPlanningDraftService } from '../researchPlanning/drafts'
import { planningReferences } from '../researchPlanning/references'
import { getStoreValue } from '../library/store'
import { createPlanningExchangeService } from '../researchPlanning/exchangeService'
import { readSelectedPlanningFile, writeSelectedPlanningExport } from '../researchPlanning/exchangeFiles'
import { planningCommandSchema } from '../researchPlanning/mutations'
import { planningDate, planningDraftWriteSchema, planningId, planningInputSchema, planningRevision, planningScopeSchema, PlanningError } from '../researchPlanning/validation'

const filterSchema = z.object({
  keyword: z.string().max(4000).optional(), kind: planningInputSchema.shape.kind.optional(), typeId: planningId.optional(), collectionId: planningId.optional(),
  projectId: planningId.optional(), status: planningInputSchema.shape.status.optional(), archived: z.enum(['exclude', 'only', 'include']).optional(),
  deleted: z.boolean().optional(), important: z.boolean().optional(), done: z.boolean().optional(), myDay: planningDate.optional(), dateFrom: planningDate.optional(), dateTo: planningDate.optional(), dueBefore: planningDate.optional(), priority: planningInputSchema.shape.priority.optional()
}).strict().refine(f => !f.dateFrom || !f.dateTo || f.dateFrom <= f.dateTo)
const schemas = {
  bootstrap: z.object({}).strict(),
  list: z.object({ scope: planningScopeSchema, filter: filterSchema, page: z.number().int().min(1).max(1_000_000) }).strict(),
  detail: z.object({ scope: planningScopeSchema, itemId: planningId }).strict(),
  save: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, itemId: planningId.optional(), input: planningInputSchema }).strict(),
  mutate: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, command: planningCommandSchema, preview: z.boolean().optional() }).strict(),
  summary: z.object({ scope: planningScopeSchema, date: planningDate, projectIds: z.array(planningId).max(50).optional() }).strict(),
  calendar: z.object({ scope: planningScopeSchema, from: planningDate, to: planningDate, filter: filterSchema.optional() }).strict(),
  drafts: z.object({ scope: planningScopeSchema }).strict(),
  saveDraft: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, draft: planningDraftWriteSchema }).strict(),
  removeDraft: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, draftId: planningId }).strict(),
  references: z.object({ scope: planningScopeSchema, kind: z.enum(['paper', 'libraryProject', 'experiment']), keyword: z.string().max(4000), page: z.number().int().min(1).max(1_000_000), ids: z.array(z.string().min(1).max(1000)).max(200).optional() }).strict(),
  selectImport: z.object({ scope: planningScopeSchema }).strict(),
  previewImport: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, importId: z.string().uuid(), options: z.object({ strategy: z.enum(['skip', 'copy', 'update']), collections: z.record(planningId, planningId).refine(value => Object.keys(value).length <= 200) }).strict() }).strict(),
  applyImport: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, importId: z.string().uuid(), previewToken: z.string().uuid() }).strict(),
  importDifference: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, importId: z.string().uuid(), previewToken: z.string().uuid(), itemId: planningId }).strict(),
  exportPreview: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, format: z.enum(['json', 'markdown', 'csv', 'html']) }).strict(),
  saveExport: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, previewToken: z.string().uuid() }).strict()
}
interface Options {
  windowRef: { current: BrowserWindow | null }; runtime?: PlanningRuntime
  selectImportPath?(win: BrowserWindow): Promise<string | undefined>
  selectExportPath?(win: BrowserWindow, format: PlanningExportFormat): Promise<string | undefined>
}
async function nativeImportPath(win: BrowserWindow) {
  const result = await dialog.showOpenDialog(win, { title: '选择科研计划JSON（先预览）', properties: ['openFile'], filters: [{ name: '科研计划JSON', extensions: ['json'] }] })
  return result.canceled ? undefined : result.filePaths[0]
}
async function nativeExportPath(win: BrowserWindow, format: PlanningExportFormat) {
  const extension = format === 'markdown' ? 'md' : format
  const result = await dialog.showSaveDialog(win, { title: '将科研计划保存为新文件', defaultPath: `Mimir-planning-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.${extension}`, filters: [{ name: `科研计划${format}`, extensions: [extension] }] })
  return result.canceled ? undefined : result.filePath
}
export function registerResearchPlanningHandlers({ windowRef, runtime = planningRuntime, selectImportPath = nativeImportPath, selectExportPath = nativeExportPath }: Options) {
  const exchange = createPlanningExchangeService(), watched = new WeakSet<object>()
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    ipcMain.handle(PLANNING_CHANNELS[name], async (event: IpcMainInvokeEvent, value: unknown) => {
      let cleanup: (() => void) | undefined
      try {
        const win = windowRef.current, sender = event.sender
        if (!win || win.isDestroyed() || sender !== win.webContents || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) throw new PlanningError('BAD_REQUEST', '仅允许工作台主窗口操作')
        const parsed = schemas[name].safeParse(value)
        if (!parsed.success) throw new PlanningError('BAD_REQUEST', '请求字段非法或超限')
        if (!watched.has(sender)) { watched.add(sender); sender.once('destroyed', () => exchange.clearOwner(sender.id)) }
        const controller = new AbortController(), onDestroy = () => controller.abort()
        sender.once('destroyed', onDestroy); cleanup = () => sender.removeListener('destroyed', onDestroy)
        return await runtime.run(async ctx => {
          if ('scope' in parsed.data) {
            const scope = planningScopeSchema.parse(parsed.data.scope)
            if (scope.workspaceId !== ctx.scope.id || scope.spaceEpoch !== ctx.scope.epoch) throw new PlanningError('SPACE_CHANGED', '科研空间已变化，请保留输入并重新打开')
          }
          const service = createPlanningService(ctx)
          if (name === 'selectImport') {
            const path = await selectImportPath(win)
            ctx.assertCurrent()
            return { ok: true, canceled: !path, selection: path ? exchange.select(ctx, sender.id, basename(path), readSelectedPlanningFile(path)) : null }
          }
          if (name === 'previewImport') { const r = schemas.previewImport.parse(value); return { ok: true, ...exchange.preview(ctx, sender.id, r.importId, r.expectedRevision, r.options) } }
          if (name === 'applyImport') { const r = schemas.applyImport.parse(value); return { ok: true, ...exchange.apply(ctx, sender.id, r.importId, r.previewToken, r.expectedRevision) } }
          if (name === 'importDifference') { const r = schemas.importDifference.parse(value); return { ok: true, ...exchange.difference(ctx, sender.id, r.importId, r.previewToken, r.expectedRevision, r.itemId) } }
          if (name === 'exportPreview') { const r = schemas.exportPreview.parse(value); return { ok: true, ...exchange.exportPreview(ctx, sender.id, r.expectedRevision, r.format) } }
          if (name === 'saveExport') {
            const r = schemas.saveExport.parse(value), before = exchange.exportPayload(ctx, sender.id, r.previewToken, r.expectedRevision)
            const path = await selectExportPath(win, before.format)
            ctx.assertCurrent()
            const payload = exchange.exportPayload(ctx, sender.id, r.previewToken, r.expectedRevision)
            if (!path) return { ok: true, saved: false, canceled: true }
            writeSelectedPlanningExport(ctx, path, payload.bytes)
            exchange.finishExport(sender.id, r.previewToken)
            return { ok: true, saved: true, canceled: false, fileName: basename(path) }
          }
          if (name === 'references') { const r = schemas.references.parse(value); const refs = planningReferences(getStoreValue, r.kind, r.keyword, r.page, r.ids); ctx.assertCurrent(); return { ok: true, scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch }, ...refs } }
          if (name === 'drafts') return { ok: true, ...createPlanningDraftService(ctx).list() }
          if (name === 'saveDraft') { const r = schemas.saveDraft.parse(value); return { ok: true, ...createPlanningDraftService(ctx).save(r.expectedRevision, r.draft) } }
          if (name === 'removeDraft') { const r = schemas.removeDraft.parse(value); return { ok: true, ...createPlanningDraftService(ctx).remove(r.expectedRevision, r.draftId) } }
          if (name === 'bootstrap') return { ok: true, ...service.bootstrap() }
          if (name === 'list') { const r = schemas.list.parse(value); return { ok: true, ...service.list(r.filter, r.page) } }
          if (name === 'detail') return { ok: true, ...service.detail(schemas.detail.parse(value).itemId) }
          if (name === 'summary') { const r = schemas.summary.parse(value); return { ok: true, ...service.summary(r.date, r.projectIds) } }
          if (name === 'calendar') { const r = schemas.calendar.parse(value); return { ok: true, ...service.calendar(r.from, r.to, r.filter) } }
          if (name === 'mutate') { const r = schemas.mutate.parse(value); return { ok: true, ...service.mutate(r.expectedRevision, r.command, r.preview) } }
          const r = schemas.save.parse(value)
          return { ok: true, ...service.save(r.expectedRevision, r.input, r.itemId) }
        }, controller)
      } catch (error) {
        if (error instanceof PlanningError) return { ok: false, code: error.code, message: error.message, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
        return { ok: false, code: 'WRITE_FAILED', message: '操作未完成，请保留输入并检查本机资料后重试' }
      } finally { cleanup?.() }
    })
  }
}
