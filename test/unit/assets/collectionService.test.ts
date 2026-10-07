import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset } from '../../../electron/assets/assetService'
import { searchAssets } from '../../../electron/assets/searchService'
import { setFavorite, recordUsage, createSavedFilter, updateSavedFilter, deleteSavedFilter, listSavedFilters } from '../../../electron/assets/collectionService'
let root:string,manager:AssetsStoreManager,ctx:AssetsContext
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),'assets-collection-'));manager=new AssetsStoreManager({active:()=>({id:'A',path:root}),epoch:()=> 'A#1'},(p,o)=>new Database(p,o));ctx=await manager.getForRequest(manager.context())})
afterEach(async()=>{vi.useRealTimers();await manager.close();rmSync(root,{recursive:true,force:true})})
const create=(name:string)=>createAsset(ctx,{name,category:'inbox',storageType:'inline_text',content:' 原文\r\n\n'})
it('收藏幂等、取用不改编辑revision/时间/正文历史；缺失/归档整批使用零写',()=>{
  const a=create('A'),b=create('B')
  setFavorite(ctx,{assetId:a.id,favorite:true});setFavorite(ctx,{assetId:a.id,favorite:true})
  expect(getAsset(ctx,a.id)).toMatchObject({isFavorite:1,revision:a.revision,updatedAt:a.updatedAt,currentVersionId:a.currentVersionId,versionCount:1})
  const before=getAsset(ctx,a.id).lastUsedAt
  expect(()=>recordUsage(ctx,{assetIds:[a.id,999]})).toThrow();expect(getAsset(ctx,a.id).lastUsedAt).toBe(before)
  ctx.write(s=>s.run("UPDATE asset SET archived_at='now' WHERE id=?",b.id))
  expect(()=>recordUsage(ctx,{assetIds:[a.id,b.id]})).toThrow();expect(getAsset(ctx,a.id).lastUsedAt).toBe(before)
  expect(()=>setFavorite(ctx,{assetId:a.id,favorite:'true'})).toThrow();expect(()=>recordUsage(ctx,{assetIds:Array(1)})).toThrow()
})
it('收藏/最近与分页全文组合；默认最近时间排序，显式名称排序保留',()=>{
  const a=create('Z科研'),b=create('A科研');setFavorite(ctx,{assetId:a.id,favorite:true})
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));recordUsage(ctx,{assetIds:[b.id]});vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));recordUsage(ctx,{assetIds:[a.id,a.id]})
  expect(searchAssets(ctx,{view:'favorites',q:'科研'}).items.map(a=>a.id)).toEqual([a.id])
  expect(searchAssets(ctx,{view:'recent',pageSize:1}).items.map(a=>a.id)).toEqual([a.id])
  expect(searchAssets(ctx,{view:'recent',sort:'name'}).items.map(a=>a.id)).toEqual([b.id,a.id])
  expect(searchAssets(ctx,{view:'recent'}).items[0]).toMatchObject({isFavorite:1,lastUsedAt:'2026-10-02T00:00:00.000Z'})
  expect(()=>searchAssets(ctx,{view:'bad'})).toThrow()
})
it('保存筛选规范化不保存页码或选择；条件更新/删除冲突零写，坏日期/稀疏条件拒绝',()=>{
  const f=createSavedFilter(ctx,{name:'  科研最近  ',query:{q:' 科研 ',view:'recent',page:2,pageSize:10,ids:[1]}})
  expect(f).toMatchObject({name:'科研最近',revision:1,query:{q:'科研',view:'recent'}})
  expect(f.query).not.toHaveProperty('page');expect(f.query).not.toHaveProperty('ids')
  expect(listSavedFilters(ctx)).toEqual([f])
  const next=updateSavedFilter(ctx,{filterId:f.id,expectedRevision:1,name:'重命名',query:{kind:null,searchIn:'body',tagIds:[1]}})
  expect(next.revision).toBe(2)
  expect(()=>updateSavedFilter(ctx,{filterId:f.id,expectedRevision:1,name:'旧修改',query:{}})).toThrow();expect(()=>deleteSavedFilter(ctx,{filterId:f.id,expectedRevision:1})).toThrow()
  for(const query of [{updatedAfter:'2026-02-29'},{page:null},{tagIds:Array(1)},{unknown:1}])expect(()=>createSavedFilter(ctx,{name:'x',query})).toThrow()
  deleteSavedFilter(ctx,{filterId:f.id,expectedRevision:2});expect(listSavedFilters(ctx)).toEqual([])
})
it('同语义筛选的键序、标签序和显式默认值不制造revision变化',()=>{
  const f=createSavedFilter(ctx,{name:'幂等',query:{q:'科研',tagIds:[2,1]}})
  const next=updateSavedFilter(ctx,{filterId:f.id,expectedRevision:1,name:'幂等',query:{tagIds:[1,2],view:'all',archived:'exclude',tagMode:'and',q:'科研'}})
  expect(next.revision).toBe(1);expect(next.updatedAt).toBe(f.updatedAt);expect(next.query).toEqual(f.query)
})
it('使用上限500及SQL故障整批回滚；保存筛选失败不留行，旧scope拒绝',async()=>{
  const a=create('A'),b=create('B');ctx.write(s=>s.run(`CREATE TRIGGER use_fail BEFORE UPDATE OF last_used_at ON asset WHEN NEW.id=${b.id} BEGIN SELECT RAISE(ABORT,'failure'); END`))
  expect(()=>recordUsage(ctx,{assetIds:[a.id,b.id]})).toThrow();expect(getAsset(ctx,a.id).lastUsedAt).toBe(null)
  expect(()=>recordUsage(ctx,{assetIds:Array(501).fill(a.id)})).toThrow()
  ctx.write(s=>s.run("CREATE TRIGGER filter_fail BEFORE INSERT ON saved_filter BEGIN SELECT RAISE(ABORT,'failure'); END"))
  expect(()=>createSavedFilter(ctx,{name:'x',query:{}})).toThrow();expect(listSavedFilters(ctx)).toEqual([])
  await manager.close();expect(()=>setFavorite(ctx,{assetId:a.id,favorite:false})).toThrow()
})
it('500个不同资产全部记录同一时间，不改revision/updatedAt',()=>{
  ctx.write(s=>{for(let i=1;i<=500;i++)s.run("INSERT INTO asset(code,name,category,storage_type,created_at,updated_at) VALUES (?,?,'inbox','inline_text','old','old')",`use-${i}`,`取用${i}`)})
  const result=recordUsage(ctx,{assetIds:Array.from({length:500},(_,i)=>i+1)})
  expect(ctx.write(s=>s.get('SELECT count(*) n FROM asset WHERE last_used_at=? AND revision=1 AND updated_at=?',result.recordedAt,'old'))).toEqual({n:500})
})
