import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RESEARCH_CHANNELS, type ResearchScope } from '../../shared/libraryResearchContracts'
import { researchRuntime, type ResearchRuntime } from '../library/research/runtime'
import { assertResearchExpected, readResearchSnapshot, type ResearchContext } from '../library/research/evidenceAccess'
import { archiveQuestion, saveQuestion } from '../library/research/questionService'
import { listEvidence, listQuestions, questionDetail } from '../library/research/questionView'
import { applyPackRefresh, archivePack, listPacks, packDetail, previewPackRefresh, savePack } from '../library/research/packService'
import { serializeResearchPack } from '../library/research/export'
import { packInputSchema, questionInputSchema, ResearchError } from '../library/research/validation'
import { EvidenceError } from '../library/evidence/validation'
import { createEvidenceExportWriter } from '../library/evidence/export'

const id = z.string().min(1).max(1000), uuid = z.string().uuid(), revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), version = revision.positive()
const scopeSchema = z.object({ workspaceId: id, spaceEpoch: id }).strict()
const keyword = z.string().refine(s => Array.from(s).length <= 4000).optional(), relation = z.enum(['supports', 'opposes', 'mixed', 'unassessed']).optional()
const filter = z.object({ projectId: id.optional(), keyword, archive: z.enum(['exclude', 'only', 'include']) }).strict()
const write = { scope: scopeSchema, expectedRevision: revision, expectedEvidenceRevision: revision.optional() }
const refresh = { ...write, packId: uuid, itemIds: z.array(uuid).min(1).max(500).refine(v => new Set(v).size === v.length), expectedEvidenceRevision: revision }
const token = z.string().regex(/^[a-f0-9]{64}$/)
const schemas = {
  overview: z.object({ scope: scopeSchema.optional() }).strict(),
  listQuestions: z.object({ scope: scopeSchema, filter, page: version }).strict(),
  questionDetail: z.object({ scope: scopeSchema, questionId: uuid, version: version.optional(), page: version, keyword, relation }).strict(),
  saveQuestion: z.object({ ...write, questionId: uuid.optional(), input: questionInputSchema }).strict(),
  archiveQuestion: z.object({ ...write, questionId: uuid, archived: z.boolean() }).strict(),
  listEvidence: z.object({ scope: scopeSchema, projectId: id, keyword, relation, page: version }).strict(),
  listPacks: z.object({ scope: scopeSchema, filter, page: version }).strict(),
  packDetail: z.object({ scope: scopeSchema, packId: uuid, version: version.optional() }).strict(),
  savePack: z.object({ ...write, packId: uuid.optional(), input: packInputSchema }).strict(),
  archivePack: z.object({ ...write, packId: uuid, archived: z.boolean() }).strict(),
  previewRefresh: z.object(refresh).strict(),
  applyRefresh: z.object({ ...refresh, previewToken: token }).strict(),
  export: z.object({ scope: scopeSchema, packId: uuid, packVersion: version, expectedRevision: revision, expectedEvidenceRevision: revision, mode: z.enum(['preview', 'save']), previewToken: token.optional() }).strict().refine(r => r.mode !== 'save' || r.previewToken !== undefined)
}
function failure(error: unknown) {
  if (error instanceof ResearchError || error instanceof EvidenceError) return { ok: false as const, code: error.code, message: error.message, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }), ...(error instanceof ResearchError && error.currentEvidenceRevision !== undefined ? { currentEvidenceRevision: error.currentEvidenceRevision } : {}) }
  return { ok: false as const, code: 'WRITE_FAILED' as const, message: '操作未完成，请保留输入并检查本机资料后重试' }
}
function assertScope(ctx: ResearchContext, scope: ResearchScope): void {
  ctx.assertCurrent()
  if (scope.workspaceId !== ctx.scope.id || scope.spaceEpoch !== ctx.scope.epoch) throw new ResearchError('SPACE_CHANGED', '空间已变化，请保留输入并重新打开')
}
interface Options { windowRef: { current: BrowserWindow | null }; runtime?: ResearchRuntime; selectExportPath?: (win: BrowserWindow) => Promise<string | undefined> }
async function nativeExportPath(win: BrowserWindow) {
  const selected = await dialog.showSaveDialog(win, { title: '将写作素材保存为新文件', buttonLabel: '保存为新文件', defaultPath: `Mimir-material-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.md`, filters: [{ name: 'Markdown写作素材', extensions: ['md'] }] })
  return selected.canceled ? undefined : selected.filePath
}
function exportPayload(ctx: ResearchContext, request: z.infer<typeof schemas.export>) {
  assertResearchExpected(readResearchSnapshot(ctx), request.expectedRevision, request.expectedEvidenceRevision)
  const result = serializeResearchPack(ctx, request)
  const previewToken = createHash('sha256').update('research-export\n').update(JSON.stringify({ scope: request.scope, state: [request.expectedRevision, request.expectedEvidenceRevision], packId: request.packId, version: request.packVersion })).update(result.utf8).digest('hex')
  return { ...result, preview: { ...result.preview, previewToken, saved: false } }
}
export function registerLibraryResearchHandlers({ windowRef, runtime = researchRuntime, selectExportPath = nativeExportPath }: Options): void {
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    ipcMain.handle(RESEARCH_CHANNELS[name], async (event: IpcMainInvokeEvent, value: unknown) => {
      let cleanup: (() => void) | undefined
      try {
        const win = windowRef.current, sender = event.sender
        if (!win || win.isDestroyed() || sender !== win.webContents || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) throw new ResearchError('BAD_REQUEST', '仅允许工作台主窗口操作')
        const parsed = schemas[name].safeParse(value)
        if (!parsed.success) throw new ResearchError('BAD_REQUEST', '研究请求字段非法或超限')
        const controller = new AbortController(), onDestroy = () => controller.abort()
        sender.once('destroyed', onDestroy); cleanup = () => sender.removeListener('destroyed', onDestroy)
        return await runtime.run(async ctx => {
          if (parsed.data.scope) assertScope(ctx, parsed.data.scope)
          if (name === 'overview') {
            const snapshot = readResearchSnapshot(ctx)
            return { ok: true, ...snapshot.state, scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch }, questionCount: snapshot.document.questions.length, packCount: snapshot.document.packs.length }
          }
          if (name === 'listQuestions') { const r = schemas.listQuestions.parse(value); return { ok: true, ...listQuestions(ctx, r.filter, r.page) } }
          if (name === 'questionDetail') return { ok: true, ...questionDetail(ctx, schemas.questionDetail.parse(value)) }
          if (name === 'saveQuestion') return { ok: true, ...saveQuestion(ctx, schemas.saveQuestion.parse(value)) }
          if (name === 'archiveQuestion') { const r = schemas.archiveQuestion.parse(value); return { ok: true, ...archiveQuestion(ctx, r.questionId, r.archived, r.expectedRevision) } }
          if (name === 'listEvidence') return { ok: true, ...listEvidence(ctx, schemas.listEvidence.parse(value)) }
          if (name === 'listPacks') { const r = schemas.listPacks.parse(value); return { ok: true, ...listPacks(ctx, r.filter, r.page) } }
          if (name === 'packDetail') return { ok: true, ...packDetail(ctx, schemas.packDetail.parse(value)) }
          if (name === 'savePack') return { ok: true, ...savePack(ctx, schemas.savePack.parse(value)) }
          if (name === 'archivePack') { const r = schemas.archivePack.parse(value); return { ok: true, ...archivePack(ctx, r.packId, r.archived, r.expectedRevision) } }
          if (name === 'previewRefresh') return { ok: true, ...previewPackRefresh(ctx, schemas.previewRefresh.parse(value)) }
          if (name === 'applyRefresh') return { ok: true, ...applyPackRefresh(ctx, schemas.applyRefresh.parse(value)) }
          if (name === 'export') {
            const r = schemas.export.parse(value), result = exportPayload(ctx, r)
            if (r.mode === 'preview') return { ok: true, ...result.preview }
            if (r.previewToken !== result.preview.previewToken) throw new ResearchError('CONFLICT', '素材或来源状态已变化，请重新预览')
            const path = await selectExportPath(win)
            ctx.assertCurrent()
            const latest = exportPayload(ctx, r)
            if (latest.preview.previewToken !== result.preview.previewToken || !latest.utf8.equals(result.utf8)) throw new ResearchError('CONFLICT', '选择文件期间内容或来源状态已变化，请重新预览')
            if (!path) return { ok: true, ...result.preview, canceled: true }
            createEvidenceExportWriter()(path, result.utf8)
            return { ok: true, ...result.preview, saved: true, fileName: basename(path) }
          }
          throw new ResearchError('BAD_REQUEST')
        }, controller)
      } catch (error) { return failure(error) }
      finally { cleanup?.() }
    })
  }
}
