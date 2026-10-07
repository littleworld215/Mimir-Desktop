import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset, updateAsset } from '../../../electron/assets/assetService'
import { listAiDrafts } from '../../../electron/assets/aiDraftService'
import { listTags, createTag } from '../../../electron/assets/tagService'
import * as ai from '../../../electron/assets/aiService'

let root: string, ctx: AssetsContext, manager: AssetsStoreManager, epoch: string
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-ai-service-')); epoch = 'A#1'
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
function source(content = ' 原文\r\n\n') { return createAsset(ctx, { name: '原文', category: 'inbox', storageType: 'inline_text', content }) }
function provider(complete = vi.fn(async (_prompt: string, _signal: AbortSignal) => ({ content: '结果', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }))) { return { model: 'fake', complete } }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const result = { content: '结果', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }

it('明确发起润色只暂存完整来源，原文不变且实际Prompt保留', async () => {
  const a = source(), p = provider()
  const d = await ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: p })
  expect(getAsset(ctx, a.id)).toEqual(a)
  expect(d).toMatchObject({ sourceVersionId: a.currentVersionId, sourceRevision: 1, content: '结果', model: 'fake' })
  expect(d.promptSnapshot).toBe(p.complete.mock.calls[0][0])
  expect(d.promptSnapshot).toContain(a.currentContent)
})
it('可选Prompt复用I4默认值/多选连接符及字面原文注入，不让用户伪造原文', async () => {
  const a = source(), template = createAsset(ctx, { name: '模板', category: 'prompt', kind: 'prompt', storageType: 'inline_text', content: '{{语言:中文}}/{{格式}}\n{{原文}}', templateConfig: { version: 1, variables: { 格式: { type: 'multi', options: ['表格', '要点'], separator: '+' } } } })
  const d = await ai.generateAiDraft(ctx, { assetId: a.id, mode: 'restructure', promptAssetId: template.id, values: { 格式: ['表格', '要点'], 原文: '伪造' } }, { provider: provider() })
  expect(d.promptSnapshot).toBe('中文/表格+要点\n' + a.currentContent)
  expect(d.promptAssetId).toBe(template.id)
})
it('指定历史版本必须属于该资产；正文变化期间结果仅保存原始来源', async () => {
  const a = source(), pending = deferred<typeof result>(), p = provider(vi.fn(() => pending.promise))
  const running = ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: p })
  updateAsset(ctx, a.id, { expectedRevision: 1, expectedCurrentVersionId: a.currentVersionId }, { content: '人工修改' })
  pending.resolve(result)
  expect(await running).toMatchObject({ sourceVersionId: a.currentVersionId, sourceRevision: 1 })
  const other = source()
  await expect(ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish', sourceVersionId: other.currentVersionId }, { provider: p })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(p.complete).toHaveBeenCalledTimes(1)
})
it('非字面原文占位符也不能用values伪造，旧默认值与追加规则保持', async () => {
  const a = source()
  for (const content of ['整理{{原文:默认}}', '整理{{ 原文 }}']) {
    const template = createAsset(ctx, { name: '模板', category: 'prompt', kind: 'prompt', storageType: 'inline_text', content })
    const d = await ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish', promptAssetId: template.id, values: { 原文: '伪造' } }, { provider: provider() })
    expect(d.promptSnapshot).not.toContain('伪造')
    expect(d.promptSnapshot).toBe((content.includes(':默认') ? '整理默认' : '整理') + '\n\n---\n\n' + a.currentContent)
  }
})
it('坏值对象与NUL填值在模型调用前拒绝', async () => {
  const a = source(), p = provider()
  for (const values of [null, true, [], { x: '\u0000' }, { x: ['\u0000'] }]) {
    await expect(ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish', values }, { provider: p })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
  expect(p.complete).not.toHaveBeenCalled()
})
it('无配置、坏输入、超Prompt预算在调用前拒绝且零草稿', async () => {
  const a = source(), p = provider()
  await expect(ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: null })).rejects.toMatchObject({ code: 'AI_NO_MODEL' })
  for (const input of [{ assetId: true, mode: 'polish' }, { assetId: a.id, mode: 'bad' }, { assetId: a.id, mode: 'polish', values: { x: true } }, { assetId: a.id, mode: 'polish', unexpected: 1 }]) {
    await expect(ai.generateAiDraft(ctx, input, { provider: p })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
  const big = source('x'.repeat(62000))
  await expect(ai.generateAiDraft(ctx, { assetId: big.id, mode: 'polish' }, { provider: p })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(p.complete).not.toHaveBeenCalled(); expect(listAiDrafts(ctx).total).toBe(0)
})
it('模型失败脱敏，空返回不建草稿', async () => {
  const a = source()
  await expect(ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: provider(vi.fn(async () => { throw Error('secret-key / 原文'); })) })).rejects.toMatchObject({ code: 'AI_FAILED', message: '模型请求失败，请检查模型设置或稍后重试。' })
  await expect(ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: provider(vi.fn(async () => ({ ...result, content: '  ' }))) })).rejects.toMatchObject({ code: 'AI_EMPTY_RESULT' })
  expect(listAiDrafts(ctx).total).toBe(0)
})
it('忽略signal的provider也能及时取消，晚成功不会写草稿', async () => {
  const a = source(), pending = deferred<typeof result>(), p = provider(vi.fn(() => pending.promise)), controller = new AbortController()
  const running = ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: p, signal: controller.signal })
  await Promise.resolve()
  controller.abort(); await expect(running).rejects.toMatchObject({ code: 'AI_ABORTED' })
  expect(p.complete.mock.calls[0][1].aborted).toBe(true)
  pending.resolve(result); await Promise.resolve(); expect(listAiDrafts(ctx).total).toBe(0)
})
it('deadline中止并拒绝挂起provider；已取消请求不调用模型', async () => {
  const a = source(), pending = deferred<typeof result>(), p = provider(vi.fn(() => pending.promise))
  await expect(ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: p, timeoutMs: 5 })).rejects.toMatchObject({ code: 'AI_TIMEOUT' })
  pending.resolve(result); await Promise.resolve(); expect(listAiDrafts(ctx).total).toBe(0)
  const controller = new AbortController(); controller.abort()
  await expect(ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: p, signal: controller.signal })).rejects.toMatchObject({ code: 'AI_ABORTED' })
  expect(p.complete).toHaveBeenCalledTimes(1)
})
it('切换空间或关闭上下文后晚成功拒绝落库', async () => {
  const a = source(), pending = deferred<typeof result>(), running = ai.generateAiDraft(ctx, { assetId: a.id, mode: 'polish' }, { provider: provider(vi.fn(() => pending.promise)) })
  epoch = 'A#2'; pending.resolve(result)
  await expect(running).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
  const current = await manager.getForRequest(manager.context()); expect(listAiDrafts(current).total).toBe(0)
})
it('标签建议只读，最多8、去重、已有名复用，正文4000字提示截断', async () => {
  const a = source('x'.repeat(5000)), tag = createTag(ctx, 'Rust').tag
  const before = getAsset(ctx, a.id), tags = listTags(ctx), p = provider(vi.fn(async () => ({ ...result, content: '["rust","Rust","模型","方法","变量","接口","事务","草稿","测试","多余"]' })))
  const suggested = await ai.suggestAiTags(ctx, { assetId: a.id, max: 8 }, { provider: p })
  expect(suggested).toMatchObject({ contentTruncated: true, truncated: true })
  expect(suggested.suggestions).toEqual(expect.arrayContaining([{ name: 'rust', existingTagId: tag.id }]))
  expect(suggested.suggestions).toHaveLength(8)
  expect(p.complete.mock.calls[0][0]).not.toContain('x'.repeat(4001))
  expect(getAsset(ctx, a.id)).toEqual(before); expect(listTags(ctx)).toEqual(tags); expect(listAiDrafts(ctx).total).toBe(0)
})
it('标签采纳按当前归一名复用，保留原标签，不信任建议中的旧ID', async () => {
  const a = source(), p = provider(vi.fn(async () => ({ ...result, content: 'rust\n模型' })))
  await ai.suggestAiTags(ctx, { assetId: a.id }, { provider: p })
  const tag = createTag(ctx, 'Rust').tag
  const adopted = ai.adoptSuggestedTags(ctx, { assetId: a.id, expectedRevision: 1, names: ['rust', '模型'] })
  expect(adopted.tags).toEqual(expect.arrayContaining([expect.objectContaining({ id: tag.id, name: 'Rust' })]))
  expect(adopted.versionCount).toBe(1)
  expect(listTags(ctx)).toHaveLength(2)
  expect(() => ai.adoptSuggestedTags(ctx, { assetId: a.id, expectedRevision: 1, names: ['其他'] })).toThrow()
  expect(listTags(ctx)).toHaveLength(2)
})
