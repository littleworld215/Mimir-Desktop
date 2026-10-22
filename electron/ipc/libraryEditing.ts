import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import type { PaperRecord } from '../../shared/libraryPaperRecord'
import { getStoreValue } from '../library/store'
import { updatePaper } from '../library/libraryService'
import { createEditingService, fallbackSchema, sessionWriteSchema } from '../libraryEditing/service'
import { editingRuntime, type EditingRuntime } from '../libraryEditing/runtime'
import { EditingError, editingId, editingKindSchema, editingPaperId, editingRevision, editingScopeSchema } from '../libraryEditing/validation'
const scope = editingScopeSchema
const schemas = {
  list: z.object({}).strict(),
  detail: z.object({ scope, id: editingId }).strict(),
  open: z.object({ scope, paperId: editingPaperId, kind: editingKindSchema, resume: z.object({ draftId: editingId, revision: editingRevision }).strict().optional() }).strict(),
  saveDraft: z.object({ scope, write: sessionWriteSchema }).strict(),
  commit: z.object({ scope, writes: z.array(sessionWriteSchema).min(1).max(2) }).strict(),
  discard: z.object({ scope, id: editingId, revision: editingRevision, sessionId: editingId.optional() }).strict(),
  close: z.object({ scope, sessionId: editingId }).strict(),
  saveWithoutRecovery: z.object({ scope, paperId: editingPaperId, base: z.unknown(), fields: z.unknown().optional(), appendInput: z.string().optional() }).strict()
}
export function registerLibraryEditingHandlers({ windowRef, runtime = editingRuntime, service = createEditingService({ host: { readPaper: id => getStoreValue<Record<string, PaperRecord>>('library:papers')?.[id], updatePaper } }) }: { windowRef: { current: BrowserWindow | null }; runtime?: EditingRuntime; service?: ReturnType<typeof createEditingService> }) {
  const watched = new WeakSet<object>()
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    ipcMain.handle('libraryEditing:' + name, async (event, ...args: unknown[]) => {
      let detach: (() => void) | undefined
      try {
        const win = windowRef.current, sender = event?.sender
        if (!win || win.isDestroyed() || sender !== win.webContents || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) throw new EditingError('BAD_REQUEST', '仅允许工作台主窗口操作')
        if (args.length > 1) throw new EditingError('BAD_REQUEST')
        const value = name === 'list' && args[0] === undefined ? {} : args[0]
        if (!schemas[name].safeParse(value).success) throw new EditingError('BAD_REQUEST')
        if (!watched.has(sender)) { watched.add(sender); sender.once('destroyed', () => service.closeOwner(sender.id)) }
        const controller = new AbortController(), abort = () => controller.abort()
        sender.once('destroyed', abort); detach = () => sender.removeListener('destroyed', abort)
        return await runtime.run(async ctx => {
          ctx.assertCurrent()
          if (name !== 'list') { const r = value as { scope: z.infer<typeof scope> }; if (r.scope.workspaceId !== ctx.scope.id || r.scope.spaceEpoch !== ctx.scope.epoch) throw new EditingError('SPACE_CHANGED', '科研空间已变化') }
          if (name === 'list') return { ok: true, scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch }, drafts: service.list(ctx) }
          if (name === 'detail') return { ok: true, ...service.detail(ctx, schemas.detail.parse(value).id) }
          if (name === 'open') { const r = schemas.open.parse(value); return { ok: true, ...service.open(ctx, sender.id, r.paperId, r.kind, r.resume) } }
          if (name === 'saveDraft') return { ok: true, draft: service.save(ctx, sender.id, schemas.saveDraft.parse(value).write) }
          if (name === 'commit') return { ok: true, ...await service.commit(ctx, sender.id, schemas.commit.parse(value).writes) }
          if (name === 'discard') { const r = schemas.discard.parse(value); service.discard(ctx, sender.id, r.id, r.revision, r.sessionId); return { ok: true } }
          if (name === 'close') { service.close(ctx, sender.id, schemas.close.parse(value).sessionId); return { ok: true } }
          const { scope: _scope, ...raw } = schemas.saveWithoutRecovery.parse(value), r = fallbackSchema.safeParse(raw)
          if (!r.success) throw new EditingError('BAD_REQUEST')
          return { ok: true, paper: await service.saveWithoutRecovery(ctx, sender.id, r.data) }
        }, controller)
      } catch (error) {
        return error instanceof EditingError ? { ok: false, code: error.code, message: error.message } : { ok: false, code: 'WRITE_FAILED', message: '操作未完成，请保留输入并检查本机资料后重试' }
      } finally { detach?.() }
    })
  }
}
