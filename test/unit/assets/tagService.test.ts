import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset, updateAsset } from '../../../electron/assets/assetService'
import { listTags, createTag, addTags, removeTags, tagImpact, renameTag, mergeTags, deleteTag } from '../../../electron/assets/tagService'
import { createSavedFilter, listSavedFilters } from '../../../electron/assets/collectionService'

let root: string, manager: AssetsStoreManager, ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-tags-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
const asset = (tagNames: string[] = []) => createAsset(ctx, { name: 'Text', category: 'inbox', storageType: 'inline_text', content: 'original', tagNames })

it('合并原子修复包含/排除筛选并递增筛选revision；删除保留失效条件避免扩大范围', () => {
  const a=createTag(ctx,'source').tag,b=createTag(ctx,'target').tag
  const f=createSavedFilter(ctx,{name:'conditions',query:{tagIds:[a.id,b.id],excludeTagIds:[a.id]}})
  mergeTags(ctx,a.id,b.id,1,1,true)
  expect(listSavedFilters(ctx)[0]).toMatchObject({id:f.id,revision:2,query:{tagIds:[b.id],excludeTagIds:[b.id]}})
  deleteTag(ctx,b.id,2,true)
  expect(listSavedFilters(ctx)[0].query.tagIds).toEqual([b.id])
})
it('筛选修复SQL失败时合并与资产标签一起回滚', () => {
  const a=asset(['source']),source=a.tags[0],target=createTag(ctx,'target').tag
  createSavedFilter(ctx,{name:'conditions',query:{tagIds:[source.id]}})
  ctx.write(s=>s.run("CREATE TRIGGER filter_merge_fail BEFORE UPDATE ON saved_filter BEGIN SELECT RAISE(ABORT,'fault'); END"))
  expect(()=>mergeTags(ctx,source.id,target.id,source.revision,target.revision,true)).toThrow()
  expect(getAsset(ctx,a.id)).toMatchObject({revision:a.revision,tags:[source]})
  expect(listSavedFilters(ctx)[0]).toMatchObject({revision:1,query:{tagIds:[source.id]}})
})

it('独立创建归一复用；非法名称和颜色不写入', () => {
  const a = createTag(ctx, '  Rust   Lang ', '#abc')
  expect(createTag(ctx, 'rust lang')).toEqual({ tag: a.tag, created: false })
  for (const name of ['', 'a,b', '\0']) expect(() => createTag(ctx, name)).toThrow()
  expect(() => createTag(ctx, 'new', {})).toThrow()
  expect(listTags(ctx)).toHaveLength(1)
})
it('添加删除幂等、按id或名复用、正文历史不变', () => {
  const a = asset(), t = createTag(ctx, 'Rust').tag
  const b = addTags(ctx, a.id, 1, [{ id: t.id }, { name: 'rust' }])
  expect(b).toMatchObject({ revision: 2, versionCount: 1, currentContent: 'original' })
  expect(b.tags).toHaveLength(1)
  expect(addTags(ctx, a.id, 2, [{ id: t.id }])).toEqual(b)
  const c = removeTags(ctx, a.id, 2, [t.id, t.id])
  expect(c).toMatchObject({ revision: 3, tags: [] })
  expect(removeTags(ctx, a.id, 3, [t.id])).toEqual(c)
})
it('无效参数、陈旧资产和标签上限全部原子回滚', () => {
  const a = asset(Array.from({ length: 100 }, (_, i) => `tag${i}`))
  for (const tags of [[{ name: 'new' }], [{ name: 'new' }, { id: 9999 }], [{ id: true }], [{ id: 1, name: 'ambiguous' }]]) {
    expect(() => addTags(ctx, a.id, 1, tags)).toThrow()
    expect(getAsset(ctx, a.id)).toEqual(a)
    expect(listTags(ctx)).toHaveLength(100)
  }
  expect(() => removeTags(ctx, a.id, 9, [a.tags[0].id])).toThrow()
})
it('rename包括归档影响；旧资产表单不可恢复旧标签', () => {
  const a = asset(['Rust']), t = a.tags[0]
  ctx.write(s => s.run('UPDATE asset SET archived_at=? WHERE id=?', '2026-01-01', a.id))
  expect(tagImpact(ctx, t.id, 'RUST')).toEqual({ tagId: t.id, assetCount: 1 })
  renameTag(ctx, t.id, t.revision, 'New')
  expect(getAsset(ctx, a.id)).toMatchObject({ revision: 2, versionCount: 1, archivedAt: '2026-01-01' })
  expect(() => updateAsset(ctx, a.id, { expectedRevision: 1 }, { tagNames: ['Rust'] })).toThrow()
})
it('名称冲突提示合并；merge去重、所有受影响资产revision更新、自合并no-op', () => {
  const a = asset(['Rust', 'JS']), b = asset(['Rust'])
  const source = listTags(ctx).find(t => t.name === 'Rust')!, target = listTags(ctx).find(t => t.name === 'JS')!
  expect(tagImpact(ctx, source.id, 'js').conflictTagId).toBe(target.id)
  expect(() => renameTag(ctx, source.id, source.revision, 'JS')).toThrow(/合并/)
  expect(mergeTags(ctx, source.id, source.id, source.revision, source.revision, true)).toEqual(source)
  const merged = mergeTags(ctx, source.id, target.id, source.revision, target.revision, true)
  expect(merged.revision).toBeGreaterThan(target.revision)
  expect(listTags(ctx)).toHaveLength(1)
  for (const id of [a.id, b.id]) expect(getAsset(ctx, id)).toMatchObject({ revision: 2, versionCount: 1, tags: [{ id: target.id }] })
})
it('关联变化使旧治理条件失效；删除须确认并只删关系', () => {
  const t = createTag(ctx, 'Rust').tag, a = asset(['Rust'])
  expect(() => deleteTag(ctx, t.id, t.revision, true)).toThrow()
  const current = listTags(ctx)[0]
  expect(() => deleteTag(ctx, current.id, current.revision, false)).toThrow()
  deleteTag(ctx, current.id, current.revision, true)
  expect(getAsset(ctx, a.id)).toMatchObject({ revision: 2, tags: [], currentContent: 'original', versionCount: 1 })
})
it('SQL故障回滚改名及资产revision；治理陈旧条件零写入', () => {
  const a = asset(['Rust']), t = a.tags[0]
  ctx.write(s => s.run("CREATE TRIGGER fail_tag BEFORE UPDATE ON asset BEGIN SELECT RAISE(ABORT,'synthetic'); END"))
  expect(() => renameTag(ctx, t.id, t.revision, 'new')).toThrow('synthetic')
  expect(getAsset(ctx, a.id)).toEqual(a)
  expect(listTags(ctx)[0]).toEqual(t)
  expect(() => mergeTags(ctx, t.id, t.id, 999, t.revision, true)).toThrow()
})
it('归档资产不允许普通标签编辑；非法治理标识不隐式转换', () => {
  const a = asset(['Rust']), t = a.tags[0]
  ctx.write(s => s.run('UPDATE asset SET archived_at=? WHERE id=?', '2026-01-01', a.id))
  expect(() => addTags(ctx, a.id, 1, [{ name: 'new' }])).toThrow()
  expect(() => removeTags(ctx, a.id, 1, [t.id])).toThrow()
  expect(() => renameTag(ctx, true, 1, 'new')).toThrow()
  expect(() => deleteTag(ctx, t.id, true, true)).toThrow()
})
it('稀疏数组明确返回BAD_REQUEST且零写入', () => {
  const a = asset()
  for (const operation of [addTags, removeTags]) {
    try { operation(ctx, a.id, 1, new Array(1)); throw new Error('should reject') }
    catch (error) { expect(error).toMatchObject({ code: 'BAD_REQUEST' }) }
    expect(getAsset(ctx, a.id)).toEqual(a)
  }
})
