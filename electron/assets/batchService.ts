/** Batch metadata changes never touch versions; preview and conditional commit share the same guarded planner. */
import type { AssetBatchPreview, AssetBatchRequest, AssetBatchResult } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'
import { assetTags, selectAsset } from './assetRepository'
import { selectCategory } from './categoryRepository'
import { assertAssetCode, assertTagName, assertTagCount } from './validation'
import { normalizeTagName } from './tagNormalization'
import { replaceTags } from './tagRepository'
import { importToken } from './exchangePreview'

function bad(message='批量参数非法。'): never { throw new AssetsStoreError('BAD_REQUEST',message) }
function positive(v:unknown): number { if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1) bad();return v }
function parse(input:unknown,commit=false): AssetBatchRequest {
  if (!input||typeof input!=='object'||Array.isArray(input)) bad()
  const v=input as Record<string,unknown>
  if(Object.keys(v).some(k=>!['assets','category','addTagNames','removeTagIds',...(commit?['previewToken']:[])].includes(k))) bad()
  if(!Array.isArray(v.assets)||v.assets.length<1||v.assets.length>500) bad('请选择1–500项资产。')
  const assets=Array.from(v.assets,raw=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))bad();const r=raw as Record<string,unknown>;if(Object.keys(r).some(k=>!['assetId','expectedRevision'].includes(k)))bad();return {assetId:positive(r.assetId),expectedRevision:positive(r.expectedRevision)}})
  if(new Set(assets.map(a=>a.assetId)).size!==assets.length)bad('选择含重复资产。')
  const category=v.category===undefined?undefined:assertAssetCode(v.category)
  if(v.addTagNames!==undefined&&!Array.isArray(v.addTagNames))bad()
  if(v.removeTagIds!==undefined&&!Array.isArray(v.removeTagIds))bad()
  const addTagNames=Array.from((v.addTagNames??[]) as unknown[],assertTagName)
  assertTagCount(addTagNames.length)
  const removeTagIds=[...new Set(Array.from((v.removeTagIds??[]) as unknown[],positive))]
  if(removeTagIds.length>500)bad()
  if(category===undefined&&!addTagNames.length&&!removeTagIds.length)bad('请指定分类或标签操作。')
  return {assets,category,addTagNames,removeTagIds}
}
function plan(ctx:AssetsContext,s:AssetsWriteSession,r:AssetBatchRequest): AssetBatchPreview {
  if(r.category!==undefined&&!selectCategory(s,r.category))throw new AssetsStoreError('BAD_CATEGORY','分类不存在。')
  for(const id of r.removeTagIds??[])if(!s.get('SELECT id FROM tag WHERE id=?',id))throw new AssetsStoreError('NOT_FOUND','待移除标签不存在。')
  const rows=r.assets.map(item=>{
    const a=selectAsset(s,item.assetId)
    if(!a)throw new AssetsStoreError('NOT_FOUND','所选资产不存在。')
    if(a.archived_at!==null)throw new AssetsStoreError('ASSET_ARCHIVED','请先恢复所选归档资产。')
    if(a.revision!==item.expectedRevision)throw new AssetsStoreError('REVISION_CONFLICT','所选资产已改变，请重新选择。')
    const tags=assetTags(s,a.id),next=new Map(tags.filter(t=>!r.removeTagIds?.includes(t.id)).map(t=>[normalizeTagName(t.name),t.name]))
    for(const name of r.addTagNames??[])next.set(normalizeTagName(name),s.get<{name:string}>('SELECT name FROM tag WHERE normalized_name=?',normalizeTagName(name))?.name??name)
    assertTagCount(next.size)
    return {assetId:a.id,name:a.name,beforeCategory:a.category,afterCategory:r.category??a.category,beforeTags:tags.map(t=>t.name),afterTags:[...next.values()]}
  })
  const same=(a:string[],b:string[])=>JSON.stringify(a.map(normalizeTagName).sort())===JSON.stringify(b.map(normalizeTagName).sort())
  return {rows,changed:rows.filter(row=>row.beforeCategory!==row.afterCategory||!same(row.beforeTags,row.afterTags)).length,previewToken:importToken(ctx,s,{raw:JSON.stringify(r),mode:'skip',skipIndexes:[],rows:[]},'batch')}
}
export function previewBatch(ctx:AssetsContext,input:unknown): AssetBatchPreview {
  const r=parse(input)
  return ctx.write(s=>plan(ctx,s,r))
}
export function commitBatch(ctx:AssetsContext,input:unknown): AssetBatchResult {
  const r=parse(input,true),token=(input as {previewToken?:unknown}).previewToken
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new AssetsStoreError('PREVIEW_STALE','请重新生成批量预览。')
  return ctx.write(s=>{
    const p=plan(ctx,s,r)
    if(p.previewToken!==token)throw new AssetsStoreError('PREVIEW_STALE','条件或库已改变，请重新预览。')
    const now=new Date().toISOString(),ids:number[]=[]
    for(const row of p.rows){
      const tagsChanged=JSON.stringify(row.beforeTags.map(normalizeTagName).sort())!==JSON.stringify(row.afterTags.map(normalizeTagName).sort())
      if(row.beforeCategory===row.afterCategory&&!tagsChanged)continue
      s.run('UPDATE asset SET category=?,revision=revision+1,updated_at=? WHERE id=?',row.afterCategory,now,row.assetId)
      if(tagsChanged)replaceTags(s,row.assetId,row.afterTags)
      ids.push(row.assetId)
    }
    return {changed:ids.length,assetIds:ids}
  })
}
