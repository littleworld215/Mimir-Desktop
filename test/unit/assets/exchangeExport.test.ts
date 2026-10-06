import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, updateAsset, getAsset } from '../../../electron/assets/assetService'
import { createCategory } from '../../../electron/assets/categoryService'
import { addReference } from '../../../electron/assets/referenceService'
import { archiveAsset } from '../../../electron/assets/archiveService'
import { exportAssets } from '../../../electron/assets/exchangeExport'

let root: string, manager: AssetsStoreManager, ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-exchange-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
const create = (name: string, content = '  原文\r\n\n') => createAsset(ctx, { name, code: name.toLowerCase(), category: 'inbox', storageType: 'inline_text', content })
const json = (request: unknown = {}) => JSON.parse(exportAssets(ctx, request).content)

it('JSON三形态与中文分类/标签/配置/来源/参见可交换，不携带路径或数据库身份', () => {
  const category = createCategory(ctx, { name: '中文领域', parentCode: 'inbox' })
  const a = createAsset(ctx, { name: 'Text', code: 'text', category: category.code, storageType: 'inline_text', content: '  空白\r\n\n', notes: '备注', sourceTask: '任务', kind: 'prompt', source: { author: 'me' }, templateConfig: { version: 1, variables: { language: { type: 'single', options: ['中', '英'] } } }, tagNames: ['文献'] })
  const b = createAsset(ctx, { name: 'File', code: 'file', category: 'inbox', storageType: 'file' })
  createAsset(ctx, { name: 'Link', code: 'link', category: 'inbox', storageType: 'external_link', externalUrl: 'https://example.com/ref' })
  addReference(ctx, { sourceAssetId: a.id, targetAssetId: b.id, expectedRevision: 1 })
  const result = json({ format: 'json', query: { sort: 'name' } })
  expect(result.count).toBe(3)
  expect(result.assets.map((item: { code: string }) => item.code)).toEqual(['file', 'link', 'text'])
  const text = result.assets[2]
  expect(text).toMatchObject({ code: 'text', categoryPath: ['未分类', '中文领域'], content: '  空白\r\n\n', sourceJson: '{"author":"me"}', sourceTask: '任务', notes: '备注', kind: 'prompt', tags: [{ name: '文献' }], references: ['file'], templateConfig: a.templateConfig })
  expect(result.assets[0].content).toBeNull()
  expect(result.assets[1].externalUrl).toBe('https://example.com/ref')
  for (const item of result.assets) for (const key of ['id', 'revision', 'currentVersionId', 'filePath', 'workspaceId']) expect(item).not.toHaveProperty(key)
  expect(exportAssets(ctx, {}).fileName).toMatch(/^资产导出-\d{4}-\d{2}-\d{2}\.json$/)
})
it('导出不受当前页限制，超过200条仍完整稳定，不嵌套失效session', () => {
  for (let i = 0; i < 205; i++) create(`a-${String(i).padStart(3, '0')}`)
  const result = json({ query: { sort: 'name' } })
  expect(result.count).toBe(205)
  expect(result.assets[204].code).toBe('a-204')
  expect(new Set(result.assets.map((item: { code: string }) => item.code)).size).toBe(205)
})
it('全文/形态/归档/类型/时间/包含排除标签及排序与列表同义', () => {
  const a = createAsset(ctx, { name: 'A', code: 'a', category: 'inbox', storageType: 'inline_text', content: '科研', kind: 'prompt', tagNames: ['keep'] })
  createAsset(ctx, { name: 'B', code: 'b', category: 'inbox', storageType: 'inline_text', content: '科研', kind: 'prompt', tagNames: ['keep', 'exclude'] })
  const tagIds = ctx.write(s => s.all<{ id: number; name: string }>('SELECT id,name FROM tag'))
  const result = json({ query: { q: '科研', searchIn: 'body', storageType: 'inline_text', kind: 'prompt', category: 'inbox', updatedAfter: '2026-01-01', tagIds: [tagIds.find(t => t.name === 'keep')!.id], excludeTagIds: [tagIds.find(t => t.name === 'exclude')!.id], tagMode: 'and', sort: 'name' } })
  expect(result.assets.map((item: { code: string }) => item.code)).toEqual([a.code])
  archiveAsset(ctx, a.id, 1)
  expect(json({ query: { archived: 'only' } }).count).toBe(1)
  expect(json({ query: { archived: 'include' } }).count).toBe(2)
})
it('所选最多500，空选择为零且去重；不存在或筛选排除拒绝而非悄悄遗漏', () => {
  const a = create('a'), b = create('b')
  expect(json({ ids: [b.id, a.id, b.id], query: { sort: 'name' } }).assets.map((item: { code: string }) => item.code)).toEqual(['a', 'b'])
  expect(json({ ids: [] }).count).toBe(0)
  expect(() => exportAssets(ctx, { ids: [a.id, 999] })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
  expect(() => exportAssets(ctx, { ids: [a.id], query: { q: 'missing' } })).toThrow()
  expect(json({ ids: Array(500).fill(a.id) }).count).toBe(1)
  expect(() => exportAssets(ctx, { ids: Array(501).fill(a.id) })).toThrow()
})
it('非法格式/AI模式/分页/未知字段/稀疏或非法ID拒绝', () => {
  create('a')
  for (const payload of [null, [], { format: 'html' }, { ai: 'yes' }, { path: root }, { query: { page: 1 } }, { query: { ids: [] } }, { ids: [true] }, { ids: Array(1) }, { ids: [0] }, { ids: ['1'] }, { query: { q: 'x'.repeat(201) } }]) expect(() => exportAssets(ctx, payload)).toThrow()
})
it('500个不同所选ID跨三页完整导出，所选筛选不扩大到未选择资产', () => {
  const ids = Array.from({ length: 500 }, (_, i) => create(`a-${String(i).padStart(3, '0')}`).id)
  create('unselected')
  const result = json({ ids, query: { sort: 'name' } })
  expect(result.count).toBe(500)
  expect(new Set(result.assets.map((item: { code: string }) => item.code)).size).toBe(500)
  expect(result.assets[499].code).toBe('a-499')
  expect(result.assets.some((item: { code: string }) => item.code === 'unselected')).toBe(false)
})
it('仅原文排除资产级AI并选择最后非AI版本，正文与来源仍完整', () => {
  const a = create('a', '  original\n\n')
  createAsset(ctx, { name: 'AI', code: 'ai', category: 'inbox', storageType: 'inline_text', content: 'generated', source: { aiGenerated: true } })
  updateAsset(ctx, a.id, { expectedRevision: 1, expectedCurrentVersionId: a.currentVersionId }, { content: 'rewritten', source: { aiGenerated: true } })
  // Version-level AI on a user-authored asset is distinct from derived-asset AI.
  updateAsset(ctx, a.id, { expectedRevision: 2 }, { source: { author: 'human' } })
  expect(json().count).toBe(2)
  expect(json().assets.find((item: { code: string }) => item.code === 'ai').aiGenerated).toBe(true)
  const result = json({ ai: 'original-only' })
  expect(result.count).toBe(1)
  expect(result.assets[0]).toMatchObject({ code: 'a', content: '  original\n\n', contentVersion: 1 })
})
it('仅原文无非AI版本时沿用来源回退当前正文，文件不读二进制', () => {
  const a = createAsset(ctx, { name: 'A', code: 'a', category: 'inbox', storageType: 'inline_text', content: 'fallback', source: { aiGenerated: true } })
  updateAsset(ctx, a.id, { expectedRevision: 1 }, { source: {} })
  expect(json({ ai: 'original-only' }).assets[0]).toMatchObject({ content: 'fallback', contentVersion: 1 })
})
it('AI标志只识别JSON布尔true，数字1与字符串true不排除人工版本', () => {
  const a = create('a', 'first')
  const second = updateAsset(ctx, a.id, { expectedRevision: 1, expectedCurrentVersionId: a.currentVersionId }, { content: 'numeric author', source: { aiGenerated: 1 } })
  expect(json({ ai: 'original-only' }).assets[0]).toMatchObject({ content: 'numeric author', contentVersion: 2 })
  updateAsset(ctx, a.id, { expectedRevision: second.revision, expectedCurrentVersionId: second.currentVersionId }, { content: 'string author', source: { aiGenerated: 'true' } })
  expect(json({ ai: 'original-only' }).assets[0]).toMatchObject({ content: 'string author', contentVersion: 3 })
})
it('Markdown按分类分节，含三形态/标签/来源/参见且原文空白不归一化', () => {
  const a = create('a', '  <script>raw</script>\r\n\n'), b = create('b')
  addReference(ctx, { sourceAssetId: a.id, targetAssetId: b.id, expectedRevision: 1 })
  createAsset(ctx, { name: 'File', code: 'file', category: 'inbox', storageType: 'file' })
  createAsset(ctx, { name: 'Link', code: 'link', category: 'inbox', storageType: 'external_link', externalUrl: 'https://example.com' })
  const result = exportAssets(ctx, { format: 'markdown', query: { sort: 'name' } })
  expect(result.content).toContain('## 未分类')
  expect(result.content).toContain('  <script>raw</script>\r\n\n')
  expect(result.content).toContain('b（b）')
  expect(result.content).toContain('二进制内容不导出')
  expect(result.content).toContain('https://example.com')
  expect(result.fileName.endsWith('.md')).toBe(true)
})
it('导出任何格式不修改资产/revision/正文历史/关系及数据库完整性', () => {
  const a = create('a')
  const before = getAsset(ctx, a.id), versions = ctx.write(s => s.all('SELECT * FROM asset_version'))
  exportAssets(ctx, {}); exportAssets(ctx, { format: 'markdown' })
  expect(getAsset(ctx, a.id)).toEqual(before)
  expect(ctx.write(s => s.all('SELECT * FROM asset_version'))).toEqual(versions)
  expect(ctx.write(s => s.get('PRAGMA integrity_check'))).toEqual({ integrity_check: 'ok' })
})
