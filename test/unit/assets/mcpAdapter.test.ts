import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { createAsset, getAsset } from '../../../electron/assets/assetService'
import { createSavedFilter } from '../../../electron/assets/collectionService'
import { importFile } from '../../../electron/assets/fileService'
import { resolveWithinFiles } from '../../../electron/assets/paths'
import { dispatchAssetTool } from '../../../electron/assets/mcp/adapter'
import { startAssetsBroker } from '../../../electron/assets/mcp/broker'
import { connectAssetsBroker, localEndpoint } from '../../../electron/assets/mcp/localTransport'
import type { AssetsContext } from '../../../electron/assets/types'

let root: string, manager: AssetsStoreManager, ctx: AssetsContext, epoch: string
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-mcp-adapter-')); epoch = 'A#1'
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
function call(method: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) {
  return dispatchAssetTool({ method, args, client: '外部测试', scope: ctx.scope, signal }, async () => ctx)
}
function seed(code: string, content = '原文') { return createAsset(ctx, { code, name: code, category: 'inbox', storageType: 'inline_text', content }) }

it('历史文件按指定blob判定：历史完整、当前丢失与历史丢失互不混淆', async () => {
  const f = createAsset(ctx, { code: 'history-file', name: '历史文件', category: 'inbox', storageType: 'file' })
  const source = join(root, 'source.txt'); writeFileSync(source, 'v1')
  const first = await importFile(ctx, f.id, { expectedRevision: f.revision }, source)
  writeFileSync(source, 'v2')
  await importFile(ctx, f.id, { expectedRevision: first.revision }, source)
  const paths = ctx.write(s => s.all<{ file_path: string }>('SELECT file_path FROM asset_version WHERE asset_id=? ORDER BY version', f.id))
  expect((await call('get_asset_version', { assetCode: f.code, version: 1 })).data.fileAvailable).toBe(true)
  unlinkSync(resolveWithinFiles(ctx.layout, paths[1].file_path))
  expect((await call('get_asset', { assetCode: f.code })).data.fileAvailable).toBe(false)
  expect((await call('get_asset_version', { assetCode: f.code, version: 1 })).data.fileAvailable).toBe(true)
  unlinkSync(resolveWithinFiles(ctx.layout, paths[0].file_path))
  expect((await call('get_asset_version', { assetCode: f.code, version: 1 })).data.fileAvailable).toBe(false)
  expect(JSON.stringify(await call('get_asset_version', { assetCode: f.code, version: 1 }))).not.toContain(root)
})

it('创建kind/sourceTask及标签真正写入；v1/v2/旧baseVersion冲突与历史保留', async () => {
  const made = await call('create_asset', { name: '模板', categoryCode: 'inbox', content: ' 原文\r\n\n', kind: 'prompt', sourceTask: '任务', tags: ['科研'], confirm: true })
  const code = made.data.assetCode as string
  expect((await call('get_asset', { assetCode: code })).data).toMatchObject({ kind: 'prompt', sourceTask: '任务', tags: ['科研'], content: { content: ' 原文\r\n\n', truncated: false } })
  await call('update_metadata', { assetCode: code, baseVersion: 1, content: 'v2', confirm: true })
  expect((await call('get_asset_version', { assetCode: code, version: 1 })).data.content).toEqual({ content: ' 原文\r\n\n', truncated: false })
  await expect(call('update_metadata', { assetCode: code, baseVersion: 1, name: '不能覆盖', confirm: true })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
})

it('来源任务截断明确标记且不拆Unicode', async () => {
  const sourceTask = 'a'.repeat(1999) + '😀末尾'
  const made = await call('create_asset', { name: '长任务', categoryCode: 'inbox', content: 'x', sourceTask, confirm: true })
  const read = (await call('get_asset', { assetCode: made.data.assetCode })).data
  expect(read.sourceTaskTruncated).toBe(true)
  expect(read.sourceTask).toBe('a'.repeat(1999))
  const short = seed('short-source')
  expect((await call('get_asset', { assetCode: short.code })).data.sourceTaskTruncated).toBe(false)
})

it('kind显式null不是合法外部参数', async () => {
  await expect(call('create_asset', { name: '无效', content: 'x', categoryCode: 'inbox', kind: null, confirm: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(call('search_assets', { kind: null })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

it('全部七读工具可用，标签名搜索与保存筛选输出不泄露路径', async () => {
  const a = seed('a'); await call('add_tags', { assetCode: 'a', tags: ['科学'], confirm: true })
  await call('remove_tags', { assetCode: 'a', tags: ['不存在'], confirm: true })
  createSavedFilter(ctx, { name: '筛选', query: { q: '原文' } })
  expect((await call('search_assets', { tagCodes: ['科学'] })).data.total).toBe(1)
  expect((await call('search_assets', { tagCodes: ['缺失'] })).data.total).toBe(0)
  expect((await call('list_categories')).data.length).toBeGreaterThan(0)
  expect((await call('list_tags')).data[0]).toMatchObject({ name: '科学', usageCount: 1 })
  expect((await call('list_saved_filters')).data[0]).toMatchObject({ name: '筛选' })
  await call('remove_tags', { assetCode: 'a', tags: [' 科学 '], confirm: true })
  expect(getAsset(ctx, a.id).tags).toEqual([])
})

it('refgraph真实按depth展开，返回代码边；200节点上限如实truncated', async () => {
  seed('a'); seed('b'); seed('c')
  await call('add_reference', { assetCode: 'a', targetCode: 'b', confirm: true })
  await call('add_reference', { assetCode: 'b', targetCode: 'c', confirm: true })
  expect((await call('get_refgraph', { assetCode: 'a', depth: 1 })).data.edges).toEqual([{ fromCode: 'a', toCode: 'b' }])
  expect((await call('get_refgraph', { assetCode: 'a', depth: 2 })).data.edges).toHaveLength(2)
  for (let i = 0; i < 200; i++) { seed(`n${i}`); await call('add_reference', { assetCode: 'a', targetCode: `n${i}`, confirm: true }) }
  expect((await call('get_refgraph', { assetCode: 'a', depth: 1 })).data.truncated).toBe(true)
})

it('外部结果只存草稿，采纳严格AI标记/版本或派生，不调用模型', async () => {
  const a = seed('a')
  const saved = await call('save_ai_draft', { assetCode: 'a', mode: 'polish', content: '润色结果', confirm: true })
  expect(getAsset(ctx, a.id).currentContent).toBe('原文')
  await call('adopt_ai_draft', { draftId: saved.data.draftId, confirm: true })
  const current = getAsset(ctx, a.id)
  const v = ctx.write(s => s.get<{ source_json: string }>('SELECT source_json FROM asset_version WHERE id=?', current.currentVersionId))
  expect(JSON.parse(v!.source_json)).toMatchObject({ aiGenerated: true, model: 'external-client' })
  const draft = await call('save_ai_draft', { assetCode: 'a', mode: 'restructure', content: '派生结果', confirm: true })
  const derived = await call('adopt_ai_draft', { draftId: draft.data.draftId, confirm: true })
  expect(derived.data.assetCode).not.toBe('a')
  expect(getAsset(ctx, a.id).currentContent).toBe('润色结果')
})

it('get_asset空文件/外链只返回元信息；正文32000上限且Unicode不拆代理对', async () => {
  createAsset(ctx, { code: 'file', name: '文件', category: 'inbox', storageType: 'file' })
  createAsset(ctx, { code: 'link', name: '外链', category: 'inbox', storageType: 'external_link', externalUrl: 'https://example.org' })
  seed('text', 'a'.repeat(31999) + '😀秘密')
  expect((await call('get_asset', { assetCode: 'file' })).data).toMatchObject({ version: 0, fileAvailable: false, content: { content: '' } })
  expect((await call('get_asset', { assetCode: 'link' })).data.externalUrl).toBe('https://example.org/')
  const content = (await call('get_asset', { assetCode: 'text' })).data.content as { content: string; truncated: boolean }
  expect(content.truncated).toBe(true); expect(content.content).not.toMatch(/[\ud800-\udbff]$/)
  expect(JSON.stringify(await call('get_asset', { assetCode: 'file' }))).not.toContain(root)
})

it('参数严格：null/字符串数字/未知字段/写确认不足均零写入', async () => {
  seed('a')
  for (const args of [{ page: null }, { pageSize: 101 }, { page: '1' }, { tagCodes: [''], query: 'x' }, { sql: 'DELETE' }]) await expect(call('search_assets', args)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(call('create_asset', { name: 'x', categoryCode: 'inbox', content: 'x', confirm: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
  await expect(call('get_asset', { assetCode: 'a', maxChars: null })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(call('save_ai_draft', { assetCode: 'a', mode: 'polish', content: 'x', apiKey: 'secret', confirm: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(1)
})

it('直接服务接缝scope/signal守卫；事务中取消必须回滚全部写入', async () => {
  const a = seed('a'), abort = new AbortController()
  abort.abort()
  await expect(call('add_tags', { assetCode: 'a', tags: ['不写'], confirm: true }, abort.signal)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  const mid = new AbortController()
  const altered: AssetsContext = { ...ctx, assertCurrent: () => ctx.assertCurrent(), write: fn => ctx.write(s => fn({ ...s, run: (sql, ...params) => { const r = s.run(sql, ...params); mid.abort(); return r } })) }
  await expect(dispatchAssetTool({ method: 'create_asset', args: { name: '回滚', categoryCode: 'inbox', content: 'x', confirm: true }, client: 'x', scope: ctx.scope, signal: mid.signal }, async () => altered)).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(1)
  expect(getAsset(ctx, a.id).tags).toEqual([])
  epoch = 'A#2'
  await expect(call('get_asset', { assetCode: 'a' })).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
})

it('真实pipe+SQLite：没有外部批准零新增，批准后同一主进程服务成功', async () => {
  const dispatch = (r: Parameters<typeof dispatchAssetTool>[0]) => dispatchAssetTool(r, async () => ctx)
  let allow = false
  const broker = await startAssetsBroker({ endpoint: localEndpoint(root), currentScope: () => ctx.scope, dispatch, approve: async () => allow })
  const client = await connectAssetsBroker({ endpoint: broker.endpoint, token: broker.token, client: '真实测试' })
  try {
    const args = { name: '管道创建', categoryCode: 'inbox', content: ' 原文\n\n', confirm: true }
    await expect(client.call('create_asset', args)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' })
    expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(0)
    allow = true
    const result = await client.call('create_asset', args) as { data: { assetCode: string } }
    const read = await client.call('get_asset', { assetCode: result.data.assetCode }) as { data: { content: { content: string } } }
    expect(read.data.content.content).toBe(' 原文\n\n')
  } finally { await client.close(); await broker.close() }
})
