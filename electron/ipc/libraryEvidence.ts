import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { EVIDENCE_CHANNELS, type EvidenceFilter, type EvidenceMatrixRow, type EvidenceScope } from '../../shared/libraryEvidenceContracts'
import { readEvidence } from '../library/evidence/repository'
import { archiveEvidence, createEvidence, currentEvidenceVersion, evidenceDetail, updateEvidence, type EvidenceContext } from '../library/evidence/service'
import { evidenceRuntime, type createEvidenceRuntime } from '../library/evidence/runtime'
import { EvidenceError } from '../library/evidence/validation'

const id = z.string().min(1).max(1000)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const version = revision.positive()
const scopeSchema = z.object({ workspaceId: id, spaceEpoch: id }).strict()
export const evidenceFilterSchema = z.object({ projectId: id.optional(), keyword: z.string().max(4000).optional(), reviewState: z.enum(['draft', 'checked']).optional(), archive: z.enum(['exclude', 'only', 'include']), source: z.enum(['all', 'problem']) }).strict()
const schemas = {
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
/** Task3只提供同形状基础行；Task5替换为独立完整矩阵派生器。 */
function basicRows(ctx: EvidenceContext, filter: EvidenceFilter, page: number) {
  const document = readEvidence(ctx.scope.root), grouped = new Map<string, EvidenceMatrixRow>()
  const papers = ctx.catalog.papers(), projects = new Set(ctx.catalog.projects().map(p => p.id))
  for (const card of document.cards) {
    const v = currentEvidenceVersion(card)
    if ((filter.archive === 'exclude' && v.archived) || (filter.archive === 'only' && !v.archived) || (filter.projectId && !v.projectIds.includes(filter.projectId))) continue
    const row = grouped.get(v.paperId) ?? { paperId: v.paperId, paperSnapshot: v.paperSnapshot, missingPaper: !papers.some(p => p.arxivId === v.paperId), missingProjectIds: [], cards: [] }
    row.missingProjectIds = [...new Set([...row.missingProjectIds, ...v.projectIds.filter(id => !projects.has(id))])]
    const preview = (s: string) => Array.from(s).slice(0, 200).join('')
    row.cards.push({ cardId: card.id, version: v.version, question: preview(v.question), method: preview(v.method), datasetOrMaterial: preview(v.datasetOrMaterial), finding: preview(v.finding), limitation: preview(v.limitation), locator: v.locator, relation: v.relation, reviewState: v.reviewState, archived: v.archived, sourceStatus: row.missingPaper ? 'detached' : v.documentBinding ? 'unchecked' : 'unbound' })
    grouped.set(v.paperId, row)
  }
  const all = [...grouped.values()].sort((a, b) => a.paperId.localeCompare(b.paperId))
  return { scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch }, revision: document.revision, rows: all.slice((page - 1) * 50, page * 50), total: all.length, page, pageSize: 50 as const }
}
interface Options { windowRef: { current: BrowserWindow | null }; runtime?: ReturnType<typeof createEvidenceRuntime> }
export function registerLibraryEvidenceHandlers({ windowRef, runtime = evidenceRuntime }: Options) {
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
          if (name === 'list') { const r = schemas.list.parse(value); return { ok: true, ...basicRows(ctx, r.filter, r.page) } }
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
