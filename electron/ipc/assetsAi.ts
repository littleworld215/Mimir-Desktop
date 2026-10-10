/** 固定 AI IPC：显式确认、严格 DTO、窗口/空间隔离的取消，不开放通用执行入口。 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ASSETS_CHANNELS, type WorkspaceRequest } from '../../shared/assetsContracts'
import { assetsStoreManager, type AssetsStoreManager } from '../assets/store'
import { AssetsStoreError } from '../assets/types'
import { generateAiDraft, suggestAiTags, adoptSuggestedTags, type AssetsAiLifetime } from '../assets/aiService'
import { listAiDrafts, getAiDraft, adoptAiDraft, discardAiDraft } from '../assets/aiDraftService'

interface Options {
  manager?: Pick<AssetsStoreManager, 'getForRequest'>
  failure: (error: unknown) => object
}
interface Pending extends AssetsAiLifetime { controller: AbortController; scope: WorkspaceRequest }
function request(input: unknown, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AssetsStoreError('BAD_REQUEST', 'AI 请求必须为对象。')
  const r = input as Record<string, unknown>
  if (Object.keys(r).some(k => !['workspaceId', 'spaceEpoch', ...keys].includes(k)) ||
    typeof r.workspaceId !== 'string' || !r.workspaceId || typeof r.spaceEpoch !== 'string' || !r.spaceEpoch) {
    throw new AssetsStoreError('BAD_REQUEST', 'AI 请求空间或字段非法。')
  }
  return { r, scope: { workspaceId: r.workspaceId, spaceEpoch: r.spaceEpoch } }
}
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new AssetsStoreError('BAD_REQUEST', 'AI 请求标识非法。')
  return value
}
function confirm(value: unknown): void { if (value !== true) throw new AssetsStoreError('BAD_REQUEST', '请明确确认该 AI 操作。') }

export function registerAssetsAiHandlers({ manager = assetsStoreManager, failure }: Options): void {
  const pending = new Map<number, Map<string, Pending>>()
  const modelHandler = (generate: boolean) => async (event: IpcMainInvokeEvent, input: unknown) => {
    let requests: Map<string, Pending> | undefined, id: string | undefined
    let owned = false, cleanup: (() => void) | undefined
    let lifetime: Pending | undefined
    try {
      const { r, scope } = request(input, ['requestId', 'confirmSend', 'input'])
      confirm(r.confirmSend); id = requestId(r.requestId)
      const sender = event.sender
      if (!sender || sender.isDestroyed()) throw new AssetsStoreError('BAD_REQUEST', '请求窗口已关闭。')
      requests = pending.get(sender.id)
      if (!requests) { requests = new Map(); pending.set(sender.id, requests) }
      if (requests.has(id) || requests.size >= 4) throw new AssetsStoreError('BAD_REQUEST', '重复或过多的在途模型请求。')
      const controller = new AbortController()
      lifetime = { controller, scope }
      requests.set(id, lifetime); owned = true
      const onDestroy = () => controller.abort()
      sender.once('destroyed', onDestroy)
      cleanup = () => sender.removeListener?.('destroyed', onDestroy)
      const ctx = await manager.getForRequest(scope)
      const result = generate ? { draft: await generateAiDraft(ctx, r.input, { signal: controller.signal, lifetime }) }
        : await suggestAiTags(ctx, r.input, { signal: controller.signal, lifetime })
      ctx.assertCurrent()
      return { ok: true, ...result }
    } catch (error) { return failure(error) }
    finally {
      const release = () => {
        cleanup?.()
        if (owned && requests && id) {
          requests.delete(id)
          if (requests.size === 0) for (const [owner, entries] of pending) if (entries === requests) pending.delete(owner)
        }
      }
      // 取消/超时响应可先回UI，真实请求仍占名额并监听窗口销毁。
      if (lifetime?.completion) void lifetime.completion.then(release, release)
      else release()
    }
  }
  ipcMain.handle(ASSETS_CHANNELS.generateAiDraft, modelHandler(true))
  ipcMain.handle(ASSETS_CHANNELS.suggestAiTags, modelHandler(false))
  ipcMain.handle(ASSETS_CHANNELS.cancelAiRequest, async (event, input: unknown) => {
    try {
      const { r, scope } = request(input, ['requestId']), id = requestId(r.requestId)
      await manager.getForRequest(scope)
      const entry = pending.get(event.sender.id)?.get(id)
      const matches = entry?.scope.workspaceId === scope.workspaceId && entry?.scope.spaceEpoch === scope.spaceEpoch
      if (matches) entry!.controller.abort()
      return { ok: true, canceled: matches }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle(ASSETS_CHANNELS.listAiDrafts, async (_event, input: unknown) => {
    try { const { r, scope } = request(input, ['query']); return { ok: true, page: listAiDrafts(await manager.getForRequest(scope), r.query) } }
    catch (error) { return failure(error) }
  })
  ipcMain.handle(ASSETS_CHANNELS.getAiDraft, async (_event, input: unknown) => {
    try { const { r, scope } = request(input, ['draftId']); return { ok: true, draft: getAiDraft(await manager.getForRequest(scope), r.draftId) } }
    catch (error) { return failure(error) }
  })
  ipcMain.handle(ASSETS_CHANNELS.adoptAiDraft, async (_event, input: unknown) => {
    try { const { r, scope } = request(input, ['draftId', 'confirm', 'input']); confirm(r.confirm); return { ok: true, ...adoptAiDraft(await manager.getForRequest(scope), r.draftId, r.input) } }
    catch (error) { return failure(error) }
  })
  ipcMain.handle(ASSETS_CHANNELS.discardAiDraft, async (_event, input: unknown) => {
    try { const { r, scope } = request(input, ['draftId', 'confirm']); confirm(r.confirm); return { ok: true, ...discardAiDraft(await manager.getForRequest(scope), r.draftId) } }
    catch (error) { return failure(error) }
  })
  ipcMain.handle(ASSETS_CHANNELS.adoptSuggestedTags, async (_event, input: unknown) => {
    try { const { r, scope } = request(input, ['confirm', 'input']); confirm(r.confirm); return { ok: true, asset: adoptSuggestedTags(await manager.getForRequest(scope), r.input) } }
    catch (error) { return failure(error) }
  })
}
