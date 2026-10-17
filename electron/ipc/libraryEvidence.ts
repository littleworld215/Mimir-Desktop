import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EVIDENCE_CHANNELS, type EvidenceScope } from '../../shared/libraryEvidenceContracts'
import { readEvidence } from '../library/evidence/repository'
import { archiveEvidence, createEvidence, evidenceDetail, updateEvidence, type EvidenceContext } from '../library/evidence/service'
import { deriveEvidenceMatrix } from '../library/evidence/matrix'
import { createEvidenceExportWriter, serializeEvidenceExport } from '../library/evidence/export'
import { evidenceRuntime, type createEvidenceRuntime } from '../library/evidence/runtime'
import { EvidenceError } from '../library/evidence/validation'

const id = z.string().min(1).max(1000)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const version = revision.positive()
const scopeSchema = z.object({ workspaceId: id, spaceEpoch: id }).strict()
export const evidenceFilterSchema = z.object({ projectId: id.optional(), keyword: z.string().max(4000).optional(), reviewState: z.enum(['draft', 'checked']).optional(), archive: z.enum(['exclude', 'only', 'include']), source: z.enum(['all', 'problem']) }).strict()
const schemas = {
  export: z.object({ scope: scopeSchema, expectedRevision: revision, filter: evidenceFilterSchema, format: z.enum(['markdown', 'csv', 'json']), mode: z.enum(['preview', 'save']), includeHistory: z.boolean().optional(), previewToken: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(r => (r.format === 'json' ? r.includeHistory !== false : r.includeHistory !== true) && (r.mode !== 'save' || r.previewToken !== undefined)),
  list: z.object({ scope: scopeSchema.optional(), filter: evidenceFilterSchema, page: version }).strict(),
  detail: z.object({ scope: scopeSchema, cardId: z.string().uuid() }).strict(),
  create: z.object({ scope: scopeSchema, expectedRevision: revision, input: z.unknown() }).strict(),
  update: z.object({ scope: scopeSchema, cardId: z.string().uuid(), expectedRevision: revision, input: z.unknown() }).strict(),
  archive: z.object({ scope: scopeSchema, cardId: z.string().uuid(), expectedRevision: revision, archived: z.boolean() }).strict(),
  checkSource: z.discriminatedUnion('mode', [z.object({ scope: scopeSchema, cardId: z.string().uuid(), mode: z.literal('inspect'), version }).strict(), z.object({ scope: scopeSchema, cardId: z.string().uuid(), mode: z.literal('confirm'), expectedRevision: revision }).strict()]),
  openSource: z.object({ scope: scopeSchema, cardId: z.string().uuid(), version }).strict()
}
export function evidenceFailure(error: unknown) {
  if (error instanceof EvidenceError) return { ok: false as const, code: error.code, message: error.message, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
  return { ok: false as const, code: 'WRITE_FAILED' as const, message: '操作未完成，请保留输入并检查本机文件后重试' }
}
export function assertEvidenceScope(ctx: EvidenceContext, requested: EvidenceScope): void {
  ctx.assertCurrent()
  if (requested.workspaceId !== ctx.scope.id || requested.spaceEpoch !== ctx.scope.epoch) throw new EvidenceError('SPACE_CHANGED', '空间已变化，请重新打开')
}
interface Options {
  windowRef: { current: BrowserWindow | null }; runtime?: ReturnType<typeof createEvidenceRuntime>
  selectExportPath?: (win: BrowserWindow, format: 'markdown' | 'csv' | 'json') => Promise<string | undefined>
}
async function nativeExportPath(win: BrowserWindow, format: 'markdown' | 'csv' | 'json') {
  const extension = format === 'markdown' ? 'md' : format
  const selected = await dialog.showSaveDialog(win, { title: '将证据导出到新文件（不覆盖已有文件）', buttonLabel: '保存为新文件', defaultPath: `Mimir-evidence-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.${extension}`, filters: [{ name: '文献证据', extensions: [extension] }] })
  return selected.canceled ? undefined : selected.filePath
}
export function registerLibraryEvidenceHandlers({ windowRef, runtime = evidenceRuntime, selectExportPath = nativeExportPath }: Options) {
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    ipcMain.handle(EVIDENCE_CHANNELS[name], async (event: IpcMainInvokeEvent, value: unknown) => {
      let cleanup: (() => void) | undefined
      try {
        const win = windowRef.current, sender = event.sender
        if (!win || win.isDestroyed() || sender !== win.webContents || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) throw new EvidenceError('BAD_REQUEST', '仅允许工作台主窗口操作')
        const parsed = schemas[name].safeParse(value)
        if (!parsed.success) throw new EvidenceError('BAD_REQUEST', '证据请求字段非法')
        const request = parsed.data
        const controller = new AbortController(), onDestroy = () => controller.abort()
        sender.once('destroyed', onDestroy); cleanup = () => sender.removeListener('destroyed', onDestroy)
        return await runtime.run(async ctx => {
          if (request.scope) assertEvidenceScope(ctx, request.scope)
          else if (name !== 'list' || !('page' in request) || request.page !== 1 || JSON.stringify(request.filter) !== JSON.stringify({ archive: 'exclude', source: 'all' })) throw new EvidenceError('BAD_REQUEST', '首次读取仅允许默认全部范围')
          // 各通道单独解析以保留精确类型；不将非判别联合强制断言为另一通道DTO。
          if (name === 'list') {
            const r = schemas.list.parse(value), document = readEvidence(ctx.scope.root)
            return { ok: true, scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch }, revision: document.revision, ...deriveEvidenceMatrix(document, ctx.catalog.papers(), ctx.catalog.projects(), r.filter, r.page, runtime.source.sourceObservations(ctx)) }
          }
          if (name === 'export') {
            const r = schemas.export.parse(value), document = readEvidence(ctx.scope.root)
            if (document.revision !== r.expectedRevision) throw new EvidenceError('CONFLICT', '证据已变化，请重新预览导出范围', document.revision)
            const result = serializeEvidenceExport(document, r.filter, r.format, { papers: ctx.catalog.papers(), observations: runtime.source.sourceObservations(ctx) })
            const counts = { cardCount: result.cardCount, versionCount: result.versionCount, previewToken: createHash('sha256').update(result.utf8).digest('hex') }
            if (r.mode === 'preview') return { ok: true, ...counts, saved: false }
            if (r.previewToken !== counts.previewToken) throw new EvidenceError('CONFLICT', '导出内容或来源筛选已变化，请重新预览')
            const path = await selectExportPath(win, r.format)
            ctx.assertCurrent()
            if (readEvidence(ctx.scope.root).revision !== r.expectedRevision) throw new EvidenceError('CONFLICT', '选择文件期间证据已变化，请重新预览')
            if (!path) return { ok: true, ...counts, saved: false, canceled: true }
            const latest = serializeEvidenceExport(readEvidence(ctx.scope.root), r.filter, r.format, { papers: ctx.catalog.papers(), observations: runtime.source.sourceObservations(ctx) })
            if (!latest.utf8.equals(result.utf8)) throw new EvidenceError('CONFLICT', '选择文件期间来源范围已变化，请重新预览')
            createEvidenceExportWriter()(path, result.utf8)
            return { ok: true, ...counts, saved: true, fileName: basename(path) }
          }
          if (name === 'create') { const r = schemas.create.parse(value), saved = createEvidence(ctx, r.input, r.expectedRevision); return { ok: true, revision: saved.document.revision, card: saved.card } }
          if (name === 'detail') { const r = schemas.detail.parse(value), found = evidenceDetail(ctx, r.cardId); return { ok: true, revision: found.document.revision, card: found.card } }
          if (name === 'update') { const r = schemas.update.parse(value), saved = updateEvidence(ctx, r.cardId, r.input, r.expectedRevision); return { ok: true, revision: saved.document.revision, card: saved.card } }
          if (name === 'archive') { const r = schemas.archive.parse(value), saved = archiveEvidence(ctx, r.cardId, r.archived, r.expectedRevision); return { ok: true, revision: saved.document.revision, card: saved.card } }
          if (name === 'checkSource') {
            const r = schemas.checkSource.parse(value)
            if (r.mode === 'confirm') { const saved = await runtime.source.confirmEvidenceSource(ctx, r.cardId, r.expectedRevision); return { ok: true, revision: saved.document.revision, card: saved.card } }
            return { ok: true, inspection: await runtime.source.inspectEvidenceSource(ctx, r.cardId, r.version) }
          }
          if (name === 'openSource') { const r = schemas.openSource.parse(value); return { ok: true, source: await runtime.source.openEvidenceSource(ctx, r.cardId, r.version) } }
          throw new EvidenceError('BAD_REQUEST')
        }, controller)
      } catch (error) { return evidenceFailure(error) }
      finally { cleanup?.() }
    })
  }
}
