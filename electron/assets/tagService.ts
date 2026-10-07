/** Tag governance uses a single guarded transaction, including archived asset impact. */
import type { AssetTag, TagImpact } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'
import { assertTagCount, assertTagName } from './validation'
import { normalizeTagName } from './tagNormalization'
import { assetTags, detail, selectAsset } from './assetRepository'

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new AssetsStoreError('BAD_REQUEST', '标识及版本必须为正整数。')
  return value
}
function tag(s: AssetsWriteSession, tagId: number): AssetTag {
  const row = s.get<AssetTag>('SELECT id,name,color,revision FROM tag WHERE id=?', tagId)
  if (!row) throw new AssetsStoreError('NOT_FOUND', '标签不存在。')
  return row
}
function checkRevision(current: number, expected: number): void {
  if (current !== expected) throw new AssetsStoreError('REVISION_CONFLICT', '数据已改变，请重新加载。', { currentRevision: current })
}
function ensureTag(s: AssetsWriteSession, name: string, color: string | null = null): { tag: AssetTag; created: boolean } {
  const normalized = normalizeTagName(name)
  const old = s.get<AssetTag>('SELECT id,name,color,revision FROM tag WHERE normalized_name=?', normalized)
  if (old) return { tag: old, created: false }
  s.run('INSERT INTO tag(name,normalized_name,color) VALUES (?,?,?)', name, normalized, color)
  return { tag: s.get<AssetTag>('SELECT id,name,color,revision FROM tag WHERE normalized_name=?', normalized)!, created: true }
}
function bumpAssets(s: AssetsWriteSession, tagId: number): void {
  s.run('UPDATE asset SET revision=revision+1,updated_at=? WHERE id IN (SELECT asset_id FROM asset_tag WHERE tag_id=?)', new Date().toISOString(), tagId)
}
export function listTags(ctx: AssetsContext): AssetTag[] {
  return ctx.write(s => s.all<AssetTag>('SELECT id,name,color,revision FROM tag ORDER BY normalized_name,id'))
}
export function createTag(ctx: AssetsContext, name: unknown, color?: unknown): { tag: AssetTag; created: boolean } {
  const validName = assertTagName(name)
  if (color !== undefined && (typeof color !== 'string' || color.length > 100 || color.includes('\0'))) throw new AssetsStoreError('BAD_REQUEST', '颜色必须为最多100字的文本。')
  return ctx.write(s => ensureTag(s, validName, color === undefined ? null : color as string))
}
function editTags(ctx: AssetsContext, assetId: unknown, expectedRevision: unknown, input: unknown, adding: boolean) {
  const aid = id(assetId), revision = id(expectedRevision)
  if (!Array.isArray(input) || input.length > 100) throw new AssetsStoreError('BAD_REQUEST', '标签操作必须为最多100项的数组。')
  const values = Array.from(input, value => {
    if (!adding) return { id: id(value) }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetsStoreError('BAD_REQUEST', '标签参数无效。')
    const item = value as Record<string, unknown>
    if (Object.keys(item).some(key => !['id', 'name'].includes(key)) || (item.id !== undefined) === (item.name !== undefined)) throw new AssetsStoreError('BAD_REQUEST', '标签必须提供id或名称中的一项。')
    return item.id !== undefined ? { id: id(item.id) } : { name: assertTagName(item.name) }
  })
  return ctx.write(s => {
    const row = selectAsset(s, aid)
    if (!row) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    checkRevision(row.revision, revision)
    if (row.archived_at) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
    const before = new Set(assetTags(s, aid).map(t => t.id)), after = new Set(before)
    for (const value of values) {
      const tid = 'name' in value ? ensureTag(s, value.name!).tag.id : value.id!
      if (adding) { tag(s, tid); after.add(tid) } else after.delete(tid)
    }
    assertTagCount(after.size)
    const changed = [...new Set([...before, ...after])].filter(tid => before.has(tid) !== after.has(tid))
    for (const tid of changed) {
      if (after.has(tid)) s.run('INSERT INTO asset_tag(asset_id,tag_id) VALUES (?,?)', aid, tid)
      else s.run('DELETE FROM asset_tag WHERE asset_id=? AND tag_id=?', aid, tid)
      s.run('UPDATE tag SET revision=revision+1 WHERE id=?', tid)
    }
    if (changed.length) s.run('UPDATE asset SET revision=revision+1,updated_at=? WHERE id=?', new Date().toISOString(), aid)
    return detail(s, selectAsset(s, aid)!, ctx.layout)
  })
}
export function addTags(ctx: AssetsContext, assetId: unknown, expectedRevision: unknown, tags: unknown) { return editTags(ctx, assetId, expectedRevision, tags, true) }
export function removeTags(ctx: AssetsContext, assetId: unknown, expectedRevision: unknown, tagIds: unknown) { return editTags(ctx, assetId, expectedRevision, tagIds, false) }
export function tagImpact(ctx: AssetsContext, tagId: unknown, targetName?: unknown): TagImpact {
  const tid = id(tagId), name = targetName === undefined ? undefined : assertTagName(targetName)
  return ctx.write(s => {
    tag(s, tid)
    const conflict = name === undefined ? undefined : s.get<{ id: number }>('SELECT id FROM tag WHERE normalized_name=? AND id<>?', normalizeTagName(name), tid)
    return { tagId: tid, assetCount: s.get<{ n: number }>('SELECT COUNT(*) n FROM asset_tag WHERE tag_id=?', tid)!.n, ...(conflict ? { conflictTagId: conflict.id } : {}) }
  })
}
export function renameTag(ctx: AssetsContext, tagId: unknown, expectedRevision: unknown, name: unknown): AssetTag {
  const tid = id(tagId), revision = id(expectedRevision), validName = assertTagName(name)
  return ctx.write(s => {
    const old = tag(s, tid)
    checkRevision(old.revision, revision)
    if (old.name === validName) return old
    if (s.get('SELECT id FROM tag WHERE normalized_name=? AND id<>?', normalizeTagName(validName), tid)) throw new AssetsStoreError('TAG_CONFLICT', '同名标签已存在，请选择合并。')
    bumpAssets(s, tid)
    s.run('UPDATE tag SET name=?,normalized_name=?,revision=revision+1 WHERE id=?', validName, normalizeTagName(validName), tid)
    return tag(s, tid)
  })
}
export function mergeTags(ctx: AssetsContext, sourceId: unknown, targetId: unknown, expectedSourceRevision: unknown, expectedTargetRevision: unknown, confirm: unknown): AssetTag {
  const source = id(sourceId), target = id(targetId), sr = id(expectedSourceRevision), tr = id(expectedTargetRevision)
  if (confirm !== true) throw new AssetsStoreError('BAD_REQUEST', '合并需要明确确认。')
  return ctx.write(s => {
    checkRevision(tag(s, source).revision, sr); checkRevision(tag(s, target).revision, tr)
    if (source === target) return tag(s, target)
    bumpAssets(s, source)
    s.run('INSERT OR IGNORE INTO asset_tag(asset_id,tag_id) SELECT asset_id,? FROM asset_tag WHERE tag_id=?', target, source)
    // Repair both positive and negative references within the same transaction.
    for(const f of s.all<{id:number;query_json:string}>('SELECT id,query_json FROM saved_filter')) {
      const query=JSON.parse(f.query_json) as {tagIds?:number[];excludeTagIds?:number[]}
      let changed=false
      for(const key of ['tagIds','excludeTagIds'] as const) if(query[key]?.includes(source)) {
        query[key]=[...new Set(query[key]!.map(id=>id===source?target:id))].sort((a,b)=>a-b);changed=true
      }
      if(changed)s.run('UPDATE saved_filter SET query_json=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(query),new Date().toISOString(),f.id)
    }
    s.run('DELETE FROM tag WHERE id=?', source)
    s.run('UPDATE tag SET revision=revision+1 WHERE id=?', target)
    return tag(s, target)
  })
}
export function deleteTag(ctx: AssetsContext, tagId: unknown, expectedRevision: unknown, confirm: unknown): { deletedId: number } {
  const tid = id(tagId), revision = id(expectedRevision)
  if (confirm !== true) throw new AssetsStoreError('BAD_REQUEST', '删除需要明确确认。')
  return ctx.write(s => {
    checkRevision(tag(s, tid).revision, revision)
    bumpAssets(s, tid)
    s.run('DELETE FROM tag WHERE id=?', tid)
    return { deletedId: tid }
  })
}
