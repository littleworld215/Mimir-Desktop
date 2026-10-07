import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset, updateAsset } from '../../../electron/assets/assetService'
import { archiveAsset } from '../../../electron/assets/archiveService'
import * as drafts from '../../../electron/assets/aiDraftService'
import { exportAssets } from '../../../electron/assets/exchangeExport'

let root: string, ctx: AssetsContext, manager: AssetsStoreManager
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-ai-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
function source() { return createAsset(ctx, { name: '原文', category: 'inbox', storageType: 'inline_text', content: ' 原文\r\n\n', tagNames: ['Rust'] }) }
function input(a = source(), extra: Record<string, unknown> = {}) {
  return { assetId: a.id, sourceVersionId: a.currentVersionId, sourceRevision: a.revision, mode: 'polish', content: ' AI结果\n',
    model: 'fake-model', promptAssetId: null, promptSnapshot: '{{原文}}实际请求', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 }, ...extra }
}
it('保存草稿不改变原资产/历史，按资产分页且摘要不带正文，重开仍可读', async () => {
  const a = source(), before = getAsset(ctx, a.id), d = drafts.saveAiDraft(ctx, input(a))
  expect(getAsset(ctx, a.id)).toEqual(before)
  expect(d).toMatchObject({ assetId: a.id, content: ' AI结果\n', status: 'pending', sourceRevision: 1 })
  expect(drafts.listAiDrafts(ctx, { assetId: a.id, pageSize: 1 })).toMatchObject({ total: 1, items: [{ id: d.id, assetName: '原文' }] })
  expect(drafts.listAiDrafts(ctx).items[0]).not.toHaveProperty('content')
  await manager.close(); ctx = await manager.getForRequest(manager.context())
  expect(drafts.getAiDraft(ctx, d.id)).toEqual(d)
})
it('润色采纳新增版本且保留原始字节与版本级AI溯源，成功才删除草稿', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a))
  const result = drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1, content: '' })
  expect(result.asset).toMatchObject({ id: a.id, currentContent: '', currentVersion: 2, revision: 2 })
  const rows = ctx.write(s => s.all<{ content: string; source_json: string }>('SELECT content,source_json FROM asset_version WHERE asset_id=? ORDER BY version', a.id))
  expect(rows[0].content).toBe(' 原文\r\n\n')
  expect(JSON.parse(rows[1].source_json)).toMatchObject({ aiGenerated: true, sourceAssetId: a.id, sourceVersionId: a.currentVersionId, sourceVersion: 1, edited: true, promptContentSnapshot: d.promptSnapshot })
  expect(JSON.parse(getAsset(ctx, a.id).sourceJson)).toEqual({})
  expect(drafts.listAiDrafts(ctx).total).toBe(0)
})
it('重构默认派生资产与参见，原资产/标签/历史零改动，派生AI标记独立', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a, { mode: 'restructure' })), before = getAsset(ctx, a.id)
  const result = drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 })
  expect(result.asset.id).not.toBe(a.id)
  expect(result.asset).toMatchObject({ name: '原文（AI 整理）', currentContent: d.content, versionCount: 1 })
  expect(JSON.parse(result.asset.sourceJson)).toMatchObject({ aiGenerated: true, derivedFrom: a.id })
  expect(getAsset(ctx, a.id)).toEqual(before)
  expect(ctx.write(s => s.get('SELECT source_asset_id FROM asset_reference WHERE source_asset_id=? AND target_asset_id=?', result.asset.id, a.id))).toBeDefined()
})
it('陈旧revision与正文版本不覆盖人工修改，草稿保留且可明确派生', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a))
  const b = updateAsset(ctx, a.id, { expectedRevision: 1, expectedCurrentVersionId: a.currentVersionId }, { content: '人工修改' })
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 })).toThrow()
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: b.revision })).toThrow()
  expect(getAsset(ctx, a.id)).toEqual(b)
  expect(drafts.getAiDraft(ctx, d.id)).toEqual(d)
  expect(drafts.adoptAiDraft(ctx, d.id, { expectedRevision: b.revision, carry: 'derived' }).asset.currentContent).toBe(d.content)
})
it('资产仅元信息改变也不能用旧草稿静默替换正文', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a))
  updateAsset(ctx, a.id, { expectedRevision: 1 }, { name: '新名' })
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 2 })).toThrow()
  expect(drafts.listAiDrafts(ctx).total).toBe(1)
})
it('来源版本必须属于本资产；归档/非文本/空原文/无效元信息零草稿', () => {
  const a = source(), other = source()
  for (const extra of [{ sourceVersionId: other.currentVersionId }, { mode: 'bad' }, { sourceRevision: true }, { model: '' }, { usage: { totalTokens: -1 } }, { content: true }, { unknown: 1 }, { promptAssetId: other.id }]) {
    expect(() => drafts.saveAiDraft(ctx, input(a, extra))).toThrow()
  }
  const empty = createAsset(ctx, { name: '空', category: 'inbox', storageType: 'inline_text', content: '' })
  expect(() => drafts.saveAiDraft(ctx, input(empty))).toThrow()
  const file = createAsset(ctx, { name: '文件', category: 'inbox', storageType: 'file' })
  expect(() => drafts.saveAiDraft(ctx, input(file))).toThrow()
  archiveAsset(ctx, a.id, 1)
  expect(() => drafts.saveAiDraft(ctx, input(a))).toThrow()
  expect(drafts.listAiDrafts(ctx).total).toBe(0)
})
it('生成期间资产改变仍可保存历史来源草稿，但不能直接覆盖当前', () => {
  const a = source(), request = input(a)
  updateAsset(ctx, a.id, { expectedRevision: 1, expectedCurrentVersionId: a.currentVersionId }, { content: 'new' })
  const d = drafts.saveAiDraft(ctx, request)
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 2 })).toThrow()
  expect(d.sourceVersionId).toBe(a.currentVersionId)
})
it('丢弃幂等，不增版本，不存在草稿采纳拒绝；分页参数严格', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a))
  drafts.discardAiDraft(ctx, d.id); drafts.discardAiDraft(ctx, d.id)
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 })).toThrow()
  expect(getAsset(ctx, a.id)).toEqual(a)
  for (const q of [{ page: null }, { pageSize: 501 }, { assetId: true }, { extra: 1 }]) expect(() => drafts.listAiDrafts(ctx, q)).toThrow()
})
it('派生参见写入故障回滚整个采纳，保留草稿且无半资产', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a, { mode: 'restructure' }))
  ctx.write(s => s.run("CREATE TRIGGER fault BEFORE INSERT ON asset_reference BEGIN SELECT RAISE(ABORT,'fault'); END"))
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 })).toThrow('fault')
  expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(1)
  expect(drafts.getAiDraft(ctx, d.id)).toEqual(d)
  expect(getAsset(ctx, a.id)).toEqual(a)
})
it('采纳后删除草稿故障，新增版本和revision/FTS一并回滚', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a))
  ctx.write(s => s.run("CREATE TRIGGER fault BEFORE DELETE ON ai_draft BEGIN SELECT RAISE(ABORT,'fault'); END"))
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 })).toThrow('fault')
  expect(getAsset(ctx, a.id)).toEqual(a)
  expect(drafts.getAiDraft(ctx, d.id)).toEqual(d)
})
it('Prompt删除不丢快照，归档后采纳拒绝但可丢弃；关闭上下文不能写入', async () => {
  const a = source(), p = createAsset(ctx, { name: 'Prompt', category: 'prompt', storageType: 'inline_text', kind: 'prompt', content: '{{原文}}' })
  const d = drafts.saveAiDraft(ctx, input(a, { promptAssetId: p.id }))
  ctx.write(s => s.run('DELETE FROM asset WHERE id=?', p.id))
  expect(drafts.getAiDraft(ctx, d.id).promptSnapshot).toBe(d.promptSnapshot)
  archiveAsset(ctx, a.id, 1)
  expect(() => drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 2 })).toThrow()
  drafts.discardAiDraft(ctx, d.id)
  await manager.close()
  expect(() => drafts.saveAiDraft(ctx, input(a))).toThrow()
})
it('原文导出排除派生AI资产并回到非AI版本，历史来源不变', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a))
  drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 })
  const b = getAsset(ctx, a.id), derived = drafts.saveAiDraft(ctx, input(b, { mode: 'restructure' }))
  drafts.adoptAiDraft(ctx, derived.id, { expectedRevision: b.revision })
  const result = JSON.parse(exportAssets(ctx, { ai: 'original-only' }).content)
  expect(result.assets).toHaveLength(1)
  expect(result.assets[0]).toMatchObject({ code: a.code, content: a.currentContent, contentVersion: 1 })
})
it('含AI导出保留润色版本AI标记与溯源，Markdown标记；仅原文继续保留资产级来源', () => {
  const a = source(), d = drafts.saveAiDraft(ctx, input(a))
  drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 })
  const included = JSON.parse(exportAssets(ctx, { ai: 'include' }).content).assets[0]
  expect(included.aiGenerated).toBe(true)
  expect(JSON.parse(included.sourceJson)).toMatchObject({ aiGenerated: true, model: d.model, sourceVersionId: d.sourceVersionId, promptContentSnapshot: d.promptSnapshot })
  expect(exportAssets(ctx, { format: 'markdown' }).content).toContain('⚠ AI 生成')
  expect(JSON.parse(JSON.parse(exportAssets(ctx, { ai: 'original-only' }).content).assets[0].sourceJson)).toEqual({})
})
it('64KiB溯源预检使用更长的edited=false，拒绝默认采纳必超限草稿', () => {
  const a = source(), request = input(a)
  const template = { aiGenerated: true, mode: request.mode, sourceAssetId: a.id, sourceVersionId: a.currentVersionId,
    sourceVersion: 1, sourceRevision: 1, model: request.model, promptAssetId: null, promptContentSnapshot: '',
    generatedAt: '2026-10-07T00:00:00.000Z', adoptedAt: '2026-10-07T00:00:00.000Z', edited: true, usage: request.usage }
  const size = Buffer.byteLength(JSON.stringify(template))
  expect(() => drafts.saveAiDraft(ctx, { ...request, promptSnapshot: 'x'.repeat(65536 - size) })).toThrow('64 KiB')
  expect(drafts.listAiDrafts(ctx).total).toBe(0)
})
it('删除来源级联清理草稿，快照超预算拒绝且不截断；相同正文采纳不增版本', () => {
  const a = source()
  expect(() => drafts.saveAiDraft(ctx, input(a, { promptSnapshot: 'x'.repeat(65536) }))).toThrow()
  expect(drafts.listAiDrafts(ctx).total).toBe(0)
  const d = drafts.saveAiDraft(ctx, input(a, { content: a.currentContent }))
  expect(drafts.adoptAiDraft(ctx, d.id, { expectedRevision: 1 }).asset).toEqual(a)
  const pending = drafts.saveAiDraft(ctx, input(a))
  ctx.write(s => s.run('DELETE FROM asset WHERE id=?', a.id))
  expect(drafts.listAiDrafts(ctx).total).toBe(0)
  expect(() => drafts.getAiDraft(ctx, pending.id)).toThrow()
})
