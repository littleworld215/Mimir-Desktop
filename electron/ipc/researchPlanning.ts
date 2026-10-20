import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { PLANNING_CHANNELS } from '../../shared/researchPlanningContracts'
import { planningRuntime, type PlanningRuntime } from '../researchPlanning/runtime'
import { createPlanningService } from '../researchPlanning/service'
import { planningDate, planningId, planningInputSchema, planningRevision, planningScopeSchema, PlanningError } from '../researchPlanning/validation'

const filterSchema = z.object({
  keyword: z.string().max(4000).optional(), kind: planningInputSchema.shape.kind.optional(), typeId: planningId.optional(), collectionId: planningId.optional(),
  projectId: planningId.optional(), status: planningInputSchema.shape.status.optional(), archived: z.enum(['exclude', 'only', 'include']).optional(),
  deleted: z.boolean().optional(), important: z.boolean().optional(), done: z.boolean().optional(), myDay: planningDate.optional(), dateFrom: planningDate.optional(), dateTo: planningDate.optional()
}).strict().refine(f => !f.dateFrom || !f.dateTo || f.dateFrom <= f.dateTo)
const schemas = {
  bootstrap: z.object({}).strict(),
  list: z.object({ scope: planningScopeSchema, filter: filterSchema, page: z.number().int().min(1).max(1_000_000) }).strict(),
  detail: z.object({ scope: planningScopeSchema, itemId: planningId }).strict(),
  save: z.object({ scope: planningScopeSchema, expectedRevision: planningRevision, itemId: planningId.optional(), input: planningInputSchema }).strict()
}
export function registerResearchPlanningHandlers({ windowRef, runtime = planningRuntime }: { windowRef: { current: BrowserWindow | null }; runtime?: PlanningRuntime }) {
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    ipcMain.handle(PLANNING_CHANNELS[name], async (event: IpcMainInvokeEvent, value: unknown) => {
      let cleanup: (() => void) | undefined
      try {
        const win = windowRef.current, sender = event.sender
        if (!win || win.isDestroyed() || sender !== win.webContents || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) throw new PlanningError('BAD_REQUEST', '仅允许工作台主窗口操作')
        const parsed = schemas[name].safeParse(value)
        if (!parsed.success) throw new PlanningError('BAD_REQUEST', '请求字段非法或超限')
        const controller = new AbortController(), onDestroy = () => controller.abort()
        sender.once('destroyed', onDestroy); cleanup = () => sender.removeListener('destroyed', onDestroy)
        return await runtime.run(async ctx => {
          if ('scope' in parsed.data) {
            const scope = planningScopeSchema.parse(parsed.data.scope)
            if (scope.workspaceId !== ctx.scope.id || scope.spaceEpoch !== ctx.scope.epoch) throw new PlanningError('SPACE_CHANGED', '科研空间已变化，请保留输入并重新打开')
          }
          const service = createPlanningService(ctx)
          if (name === 'bootstrap') return { ok: true, ...service.bootstrap() }
          if (name === 'list') { const r = schemas.list.parse(value); return { ok: true, ...service.list(r.filter, r.page) } }
          if (name === 'detail') return { ok: true, ...service.detail(schemas.detail.parse(value).itemId) }
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
