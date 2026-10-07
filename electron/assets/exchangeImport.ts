/** Conditional exchange import: plan and all metadata, versions and edges are committed in one guarded transaction. */
import { createHash } from 'node:crypto'
import type { AssetImportResult, AssetImportPreview, ExchangeAsset } from '../../shared/assetsContracts'
import { parseImport } from './exchangeParse'
import { previewInSession } from './exchangePreview'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'
import { appendVersion, selectAsset, assetTags, type AssetRow } from './assetRepository'
import { replaceTags } from './tagRepository'
import { normalizeTagName } from './tagNormalization'
import { insertCategory } from './categoryRepository'

export function previewImport(ctx: AssetsContext,input: unknown): AssetImportPreview {
  const parsed=parseImport(input)
  return ctx.write(s=>previewInSession(ctx,s,parsed))
}
function category(s: AssetsWriteSession,a: ExchangeAsset,now: string): string {
  if (s.get('SELECT code FROM asset_category WHERE code=?',a.category)) return a.category
  const path=a.categoryPath.length ? a.categoryPath : [a.category]
  let parent: string | null=null
  for (const name of path) {
    const found: {code:string} | undefined=s.get('SELECT code FROM asset_category WHERE name=? AND parent_code IS ? ORDER BY code LIMIT 1',name,parent)
    if (found) { parent=found.code; continue }
    const base: string=`import-${createHash('sha256').update(JSON.stringify([parent,name])).digest('hex').slice(0,24)}`
    let code: string=base
    let n=1
    while (s.get('SELECT code FROM asset_category WHERE code=?',code)) code=`${base}-${n++}`
    insertCategory(s,{code,name,icon:'folder',defaultStorageType:a.storageType,description:'',parentCode:parent,sortOrder:0,createdAt:now})
    parent=code
  }
  return parent as string
}
export function commitImport(ctx: AssetsContext,input: unknown): AssetImportResult {
  const parsed=parseImport(input,true), token=(input as {previewToken?:unknown}).previewToken
  if (typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) throw new AssetsStoreError('PREVIEW_STALE','请重新生成导入预览。')
  return ctx.write(s=> {
    const p=previewInSession(ctx,s,parsed)
    if (p.previewToken!==token) throw new AssetsStoreError('PREVIEW_STALE','库或导入条件已改变，请重新预览。')
    if (!p.canCommit) throw new AssetsStoreError('BAD_REQUEST','导入存在错误，请修正或显式跳过对应行。')
    const result: AssetImportResult={created:p.created,updated:p.updated,skipped:p.skipped,assetIds:[]}
    const now=new Date().toISOString(), ids=new Map<string,number>(), touched=new Set<number>()
    const mappings=new Map(p.rows.filter(row=>row.action==='create'||row.action==='update').map(row=>[row.code,row.targetCode]))
    for (const row of p.rows) {
      if (row.action!=='create' && row.action!=='update') continue
      const a=row.after as ExchangeAsset, cat=category(s,a,now)
      const values=[a.name,cat,a.description,a.externalUrl,a.sourceJson,a.sourceTask,a.notes,a.kind,JSON.stringify(a.templateConfig),a.isFavorite,a.lastUsedAt,a.archivedAt]
      let id: number
      if (row.action==='create') {
        s.run(`INSERT INTO asset(code,storage_type,name,category,description,external_url,source_json,source_task,notes,kind,template_config,is_favorite,last_used_at,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,row.targetCode,a.storageType,...values,now,now)
        id=s.get<{id:number}>('SELECT last_insert_rowid() id')!.id
        if (a.storageType!=='file') appendVersion(s,selectAsset(s,id) as AssetRow,a.content ?? '', 'JSON导入',now)
      } else {
        const old=s.get<AssetRow>('SELECT * FROM asset WHERE code=?',row.targetCode) as AssetRow
        id=old.id
        const oldValues=[old.name,old.category,old.description,old.external_url,old.source_json,old.source_task,old.notes,old.kind,old.template_config,old.is_favorite,old.last_used_at,old.archived_at]
        const oldText=old.current_version_id===null ? '' : s.get<{content:string}>('SELECT content FROM asset_version WHERE id=?',old.current_version_id)?.content ?? ''
        const bodyChanged=a.storageType==='inline_text' && a.content!==oldText
        const beforeTags=assetTags(s,id).map(t=>normalizeTagName(t.name)).sort()
        const tagsChanged=JSON.stringify(beforeTags)!==JSON.stringify(a.tags.map(t=>normalizeTagName(t.name)).sort())
        if (JSON.stringify(oldValues)!==JSON.stringify(values) || bodyChanged || tagsChanged) {
          s.run('UPDATE asset SET name=?,category=?,description=?,external_url=?,source_json=?,source_task=?,notes=?,kind=?,template_config=?,is_favorite=?,last_used_at=?,archived_at=?,revision=revision+1,updated_at=? WHERE id=?',...values,now,id)
          touched.add(id)
        }
        if (bodyChanged) appendVersion(s,selectAsset(s,id) as AssetRow,a.content as string,'JSON导入',now)
      }
      // Only a newly created tag takes the incoming color; existing tags are shared library metadata.
      for (const tag of a.tags) s.run('INSERT INTO tag(name,normalized_name,color) VALUES (?,?,?) ON CONFLICT(normalized_name) DO NOTHING',tag.name,normalizeTagName(tag.name),tag.color)
      replaceTags(s,id,a.tags.map(t=>t.name))
      ids.set(row.targetCode,id); result.assetIds.push(id)
    }
    for (const row of p.rows) {
      const id=ids.get(row.targetCode)
      if (id===undefined || (row.action!=='create' && row.action!=='update')) continue
      const targets=new Set<number>()
      for (const ref of row.after?.references ?? []) {
        const code=mappings.get(ref) ?? ref
        const target=ids.get(code) ?? s.get<{id:number}>('SELECT id FROM asset WHERE code=?',code)?.id
        if (target!==undefined && target!==id) targets.add(target)
      }
      const before=s.all<{target_asset_id:number}>('SELECT target_asset_id FROM asset_reference WHERE source_asset_id=?',id).map(x=>x.target_asset_id).sort((a,b)=>a-b)
      if (JSON.stringify(before)===JSON.stringify([...targets].sort((a,b)=>a-b))) continue
      s.run('DELETE FROM asset_reference WHERE source_asset_id=?',id)
      for (const target of targets) s.run('INSERT INTO asset_reference(source_asset_id,target_asset_id,created_at) VALUES (?,?,?)',id,target,now)
      if (row.action==='update' && !touched.has(id)) s.run('UPDATE asset SET revision=revision+1,updated_at=? WHERE id=?',now,id)
    }
    return result
  })
}
