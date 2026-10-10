import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), get: vi.fn(), complete: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: Function) => h.handlers.set(name, fn) }, app: { isPackaged: false } }))
vi.mock('../../electron/assets/aiProvider', () => ({ configuredAssetsAiProvider: () => ({ model: 'fake', complete: h.complete }) }))
import { AssetsStoreManager } from '../../electron/assets/store'
import { createAsset, getAsset } from '../../electron/assets/assetService'
import { listAiDrafts } from '../../electron/assets/aiDraftService'
import { registerAssetsAiHandlers } from '../../electron/ipc/assetsAi'
import { workspaceOperationGate } from '../../electron/workspaceBackup/operationGate'
import type { AssetsContext } from '../../electron/assets/types'
let root: string, manager: AssetsStoreManager, ctx: AssetsContext, epoch: string
const scope = { workspaceId: 'A', spaceEpoch: 'A#1' }
function event(id = 1) { const callbacks: Function[] = []; return { sender: { id, once: (_name: string, fn: Function) => callbacks.push(fn), isDestroyed: () => false }, destroy: () => callbacks.forEach(fn => fn()) } }
const success = { content: '结果', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
function invoke(name: string, request: object, e = event()) { return h.handlers.get('assets:' + name)!(e, { ...scope, ...request }) }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-ai-ipc-')); epoch = 'A#1'
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(scope); h.handlers.clear(); h.complete.mockReset().mockResolvedValue(success)
  registerAssetsAiHandlers({ manager, failure: e => ({ ok: false, code: e?.code ?? 'WRITE_FAILED', message: e?.message ?? '失败' }) })
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
function source() { return createAsset(ctx, { name: '原文', category: 'inbox', storageType: 'inline_text', content: '原文' }) }
it('及时取消不释放仍在执行的模型名额，真实完成后才允许同窗新请求', async () => {
  const asset = source(), e = event(23), releases: Array<(value: typeof success) => void> = []
  h.complete.mockImplementation(() => releases.length < 4 ? new Promise(resolve => { releases.push(resolve) }) : Promise.resolve(success))
  try {
    for (let index = 0; index < 4; index++) {
      const task = invoke('generateAiDraft', { requestId: 'held-' + index, confirmSend: true, input: { assetId: asset.id, mode: 'polish' } }, e)
      await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(index + 1))
      await invoke('cancelAiRequest', { requestId: 'held-' + index }, e)
      expect(await task).toMatchObject({ code: 'AI_ABORTED' })
    }
    const fifth = await invoke('generateAiDraft', { requestId: 'fifth', confirmSend: true, input: { assetId: asset.id, mode: 'polish' } }, e)
    expect(fifth).toMatchObject({ code: 'BAD_REQUEST' }); expect(h.complete).toHaveBeenCalledTimes(4)
    releases.forEach(resolve => resolve(success))
    await vi.waitFor(() => expect(workspaceOperationGate.pendingCount).toBe(0))
    expect(await invoke('generateAiDraft', { requestId: 'fifth', confirmSend: true, input: { assetId: asset.id, mode: 'polish' } }, e)).toMatchObject({ ok: true })
  } finally {
    releases.forEach(resolve => resolve(success))
    await vi.waitFor(() => expect(workspaceOperationGate.pendingCount).toBe(0))
  }
})
it('8固定方法，无确认/未知字段/伪造provider时零模型；显式生成后分页读取及条件采纳', async () => {
  expect(h.handlers.size).toBe(8)
  const asset = source(), req = { requestId: 'r1', input: { assetId: asset.id, mode: 'polish' } }
  for (const extra of [{}, { confirmSend: false }, { confirmSend: true, provider: {} }]) expect(await invoke('generateAiDraft', { ...req, ...extra })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(h.complete).not.toHaveBeenCalled()
  const result = await invoke('generateAiDraft', { ...req, confirmSend: true })
  expect(result).toMatchObject({ ok: true, draft: { content: '结果' } })
  expect(await invoke('listAiDrafts', { query: { page: 1 } })).toMatchObject({ ok: true, page: { total: 1 } })
  expect(await invoke('getAiDraft', { draftId: result.draft.id })).toMatchObject({ ok: true, draft: { content: '结果' } })
  expect(await invoke('adoptAiDraft', { draftId: result.draft.id, input: { expectedRevision: 1 } })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await invoke('adoptAiDraft', { draftId: result.draft.id, confirm: true, input: { expectedRevision: 1 } })).toMatchObject({ ok: true, asset: { currentContent: '结果' } })
})
it('请求绑定窗口与空间；重复ID拒绝，异窗不能取消，取消与晚成功零草稿', async () => {
  const a = source(); let resolve!: (v: typeof success) => void
  h.complete.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const e = event(7), req = { requestId: 'same', confirmSend: true, input: { assetId: a.id, mode: 'polish' } }
  const running = invoke('generateAiDraft', req, e)
  await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1))
  expect(await invoke('generateAiDraft', req, e)).toMatchObject({ code: 'BAD_REQUEST' })
  expect(await invoke('cancelAiRequest', { requestId: 'same' }, event(8))).toMatchObject({ ok: true, canceled: false })
  expect(await invoke('cancelAiRequest', { requestId: 'same' }, e)).toMatchObject({ ok: true, canceled: true })
  expect(await running).toMatchObject({ ok: false, code: 'AI_ABORTED' })
  resolve(success); await Promise.resolve(); expect(listAiDrafts(ctx).total).toBe(0)
})
it('窗口销毁取消请求；切空间晚返回拒绝，未知上下文不读写', async () => {
  const a = source(), e = event(5); let resolve!: (v: typeof success) => void
  h.complete.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const running = invoke('generateAiDraft', { requestId: 'destroy', confirmSend: true, input: { assetId: a.id, mode: 'polish' } }, e)
  await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1)); e.destroy()
  expect(await running).toMatchObject({ code: 'AI_ABORTED' }); resolve(success)
  h.complete.mockImplementationOnce(async () => { epoch = 'A#2'; return success })
  expect(await invoke('generateAiDraft', { requestId: 'switch', confirmSend: true, input: { assetId: a.id, mode: 'polish' } })).toMatchObject({ code: 'SPACE_CHANGED' })
  expect(await invoke('listAiDrafts', { query: {} })).toMatchObject({ code: 'SPACE_CHANGED' })
  epoch = 'A#1'; expect(listAiDrafts(ctx).total).toBe(0)
})
it('标签建议只读且采纳独立确认；失败不泄露，草稿丢弃幂等', async () => {
  const a = source()
  h.complete.mockResolvedValueOnce({ ...success, content: '["Rust"]' })
  expect(await invoke('suggestAiTags', { requestId: 'tags', confirmSend: true, input: { assetId: a.id } })).toMatchObject({ ok: true, suggestions: [{ name: 'Rust' }] })
  expect(getAsset(ctx, a.id)).toEqual(a)
  expect(await invoke('adoptSuggestedTags', { confirm: true, input: { assetId: a.id, expectedRevision: 1, names: ['rust'] } })).toMatchObject({ ok: true, asset: { revision: 2 } })
  h.complete.mockRejectedValueOnce(Error('secret-key'))
  const failed = await invoke('generateAiDraft', { requestId: 'error', confirmSend: true, input: { assetId: a.id, mode: 'polish' } })
  expect(failed).toMatchObject({ code: 'AI_FAILED' }); expect(JSON.stringify(failed)).not.toContain('secret-key')
  expect(await invoke('discardAiDraft', { draftId: 123, confirm: true })).toMatchObject({ ok: true, discarded: false })
})
