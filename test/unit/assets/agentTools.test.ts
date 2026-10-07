import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { createAsset, getAsset } from '../../../electron/assets/assetService'
import { listAiDrafts } from '../../../electron/assets/aiDraftService'
import { generateAiDraft, suggestAiTags } from '../../../electron/assets/aiService'
import { createAssetTools } from '../../../electron/agent/tools/assets'
import { setStoreValue, getStoreValue } from '../../../electron/library/store'
import { setApprovalDecider, resetApprovalSender, withApprovalSource, type ApprovalRequest } from '../../../electron/agent/approval'

let root: string, manager: AssetsStoreManager, epoch: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'assets-agent-')); epoch = 'A#1'
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
async function setup() {
  const ctx = await manager.getForRequest(manager.context())
  const asset = createAsset(ctx, { name: '科研原文', category: 'inbox', storageType: 'inline_text', content: '原文' })
  const sendApproval = vi.fn(async () => true), writeApproval = vi.fn(async () => true)
  const complete = vi.fn(async () => ({ content: '修改结果', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }))
  const provider = { model: 'fake', complete }
  const tools = createAssetTools({ manager, sendApproval, writeApproval,
    generate: (c, i, o) => generateAiDraft(c, i, { ...o, provider }),
    suggest: (c, i, o) => suggestAiTags(c, i, { ...o, provider }) })
  async function invoke(name: string, input: unknown, signal?: AbortSignal) {
    return JSON.parse(String(await tools.find(t => t.name === name)!.invoke(input, { signal })))
  }
  return { ctx, asset, sendApproval, writeApproval, complete, invoke, tools }
}
it('固定五工具只读查找/读取，不走写入批准；正文按需分页', async () => {
  const s = await setup()
  expect(s.tools.map(t => t.name)).toEqual(['asset_search', 'asset_read', 'asset_ai', 'asset_draft', 'asset_tags'])
  expect(await s.invoke('asset_search', { keyword: '科研' })).toMatchObject({ ok: true, page: { total: 1 } })
  expect(await s.invoke('asset_read', { assetId: s.asset.id, offset: 1, limit: 1 })).toMatchObject({ ok: true, content: '文', contentTruncated: true })
  expect(s.sendApproval).not.toHaveBeenCalled(); expect(s.writeApproval).not.toHaveBeenCalled()
})
it('外发拒绝零模型/零草稿；写入拒绝不采纳；通过才追加版本', async () => {
  const s = await setup()
  s.sendApproval.mockResolvedValueOnce(false)
  expect(await s.invoke('asset_ai', { assetId: s.asset.id, mode: 'polish' })).toMatchObject({ ok: false, code: 'APPROVAL_DENIED' })
  expect(s.complete).not.toHaveBeenCalled(); expect(listAiDrafts(s.ctx).total).toBe(0)
  const generated = await s.invoke('asset_ai', { assetId: s.asset.id, mode: 'polish' })
  expect(generated).toMatchObject({ ok: true, draft: { sourceRevision: 1 } })
  expect(getAsset(s.ctx, s.asset.id)).toEqual(s.asset)
  s.writeApproval.mockResolvedValueOnce(false)
  expect(await s.invoke('asset_draft', { action: 'adopt', draftId: generated.draft.id, expectedRevision: 1 })).toMatchObject({ code: 'APPROVAL_DENIED' })
  expect(listAiDrafts(s.ctx).total).toBe(1)
  expect(await s.invoke('asset_draft', { action: 'adopt', draftId: generated.draft.id, expectedRevision: 1 })).toMatchObject({ ok: true, asset: { currentContent: '修改结果', revision: 2 } })
})
it('批准等待期间切换空间零模型；取消信号阻止副作用', async () => {
  const s = await setup()
  s.sendApproval.mockImplementationOnce(async () => { epoch = 'A#2'; return true })
  expect(await s.invoke('asset_ai', { assetId: s.asset.id, mode: 'polish' })).toMatchObject({ code: 'SPACE_CHANGED' })
  expect(s.complete).not.toHaveBeenCalled()
  epoch = 'A#1'
  const controller = new AbortController()
  s.sendApproval.mockImplementationOnce(async () => { controller.abort(); return true })
  await expect(s.invoke('asset_ai', { assetId: s.asset.id, mode: 'polish' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(s.complete).not.toHaveBeenCalled()
})
it('标签只读建议与采纳隔离，丢弃总走破坏性批准；不泄漏内部错误', async () => {
  const s = await setup()
  s.complete.mockResolvedValueOnce({ content: '["标签"]', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  expect(await s.invoke('asset_tags', { action: 'suggest', assetId: s.asset.id })).toMatchObject({ ok: true, suggestions: [{ name: '标签' }] })
  expect(getAsset(s.ctx, s.asset.id)).toEqual(s.asset)
  expect(await s.invoke('asset_tags', { action: 'adopt', assetId: s.asset.id, expectedRevision: 1, names: ['标签'] })).toMatchObject({ ok: true, asset: { revision: 2 } })
  await s.invoke('asset_draft', { action: 'discard', draftId: 123 })
  expect(s.writeApproval.mock.calls.at(-1)?.[0]).toMatchObject({ summary: expect.stringMatching(/^删除/) })
  s.sendApproval.mockRejectedValueOnce(Error('secret-key / SQL'))
  expect(await s.invoke('asset_ai', { assetId: s.asset.id, mode: 'polish' })).toMatchObject({ code: 'WRITE_FAILED', message: '资产工具执行失败，请重试。' })
})
it('实际批准机制：全权档仍确认外发，写入自动审计，删除始终弹卡；无通道默认拒绝', async () => {
  const s = await setup(), seen: ApprovalRequest[] = []
  const generate = (c: Parameters<typeof generateAiDraft>[0], i: unknown, o: Parameters<typeof generateAiDraft>[2]) => generateAiDraft(c, i, { ...o, provider: { model: 'fake', complete: s.complete } })
  const tools = createAssetTools({ manager, generate })
  const ai = tools.find(t => t.name === 'asset_ai')!, draft = tools.find(t => t.name === 'asset_draft')!
  setStoreValue('settings', { permissions: { sandbox: 'danger-full-access' } })
  resetApprovalSender()
  expect(JSON.parse(String(await ai.invoke({ assetId: s.asset.id, mode: 'polish' })))).toMatchObject({ code: 'APPROVAL_DENIED' })
  expect(s.complete).not.toHaveBeenCalled()
  setApprovalDecider(r => { seen.push(r); return true })
  const generated = JSON.parse(String(await withApprovalSource({ origin: 'subagent', subagentId: 'assets' }, () => ai.invoke({ assetId: s.asset.id, mode: 'polish' }))))
  expect(seen).toHaveLength(1); expect(seen[0].source).toMatchObject({ subagentId: 'assets' })
  expect(JSON.parse(String(await draft.invoke({ action: 'adopt', draftId: generated.draft.id, expectedRevision: 1 })))).toMatchObject({ ok: true })
  expect(seen).toHaveLength(1)
  expect(getStoreValue('permissions:audit')).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'business:asset_draft', decision: 'allow' })]))
  await draft.invoke({ action: 'discard', draftId: generated.draft.id })
  expect(seen).toHaveLength(2); expect(seen[1].summary).toMatch(/^删除/)
})
it('同一Agent轮次空间快照约束之后才启动的工具，不将旧会话续写到新代际', async () => {
  const s = await setup(), captured = manager.context()
  epoch = 'A#2'
  const ai = s.tools.find(t => t.name === 'asset_ai')!
  const result = JSON.parse(String(await ai.invoke({ assetId: s.asset.id, mode: 'polish' }, { configurable: { assetsScope: captured } })))
  expect(result).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
  expect(s.sendApproval).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled()
})
