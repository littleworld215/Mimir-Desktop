import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, updateAsset, getAsset, listAssets } from '../../../electron/assets/assetService'
import { createCategory } from '../../../electron/assets/categoryService'
let root = ''
let manager: AssetsStoreManager
let ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(),'assets-core-'))
  manager = new AssetsStoreManager({ active:()=>({id:'A',path:root}),epoch:()=> 'A#1' },(p,o)=>new Database(p,o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async ()=> { await manager.close(); rmSync(root,{recursive:true,force:true}) })
function create(extra: Record<string,unknown> = {}) { return createAsset(ctx,{ name:'Text',category:'inbox',storageType:'inline_text',content:'original',...extra }) }
it('三形态：文本/外链v1与文件空壳',()=> {
  expect(create()).toMatchObject({versionCount:1,currentVersion:1,currentContent:'original'})
  expect(create({storageType:'external_link',content:'',externalUrl:'https://example.com'})).toMatchObject({versionCount:1,currentContent:''})
  expect(create({storageType:'file',content:''})).toMatchObject({versionCount:0,currentVersionId:null})
})
it('无效kind/config/category/url/类型均零写入',()=> {
  for(const input of [{kind:'bad'},{templateConfig:{version:2}},{category:'ghost'},{storageType:'external_link'},
    {storageType:'external_link',externalUrl:'file:///x'},{name:true},{notes:{}},{source:[]},{tagNames:[true]}]) expect(()=>create(input)).toThrow()
  expect(listAssets(ctx).total).toBe(0)
})
it('重复code拒绝且原资产不变',()=> {
  const a = create({code:'same'})
  expect(()=>create({code:'same'})).toThrow()
  expect(getAsset(ctx,a.id)).toEqual(a)
})
it('元信息/相同正文不增版本，no-op不增revision',()=> {
  const a=create()
  const b=updateAsset(ctx,a.id,{expectedRevision:1},{name:'Renamed',kind:null})
  expect(b).toMatchObject({revision:2,versionCount:1})
  const c=updateAsset(ctx,a.id,{expectedRevision:2,expectedCurrentVersionId:b.currentVersionId},{content:'original',name:'Renamed'})
  expect(c).toEqual(b)
})
it('字节变化与清空新增不可变版本',()=> {
  const a=create()
  const b=updateAsset(ctx,a.id,{expectedRevision:1,expectedCurrentVersionId:a.currentVersionId},{content:''})
  expect(b).toMatchObject({currentContent:'',currentVersion:2,versionCount:2,revision:2})
  expect(ctx.write(s=>s.get<{content:string}>('SELECT content FROM asset_version WHERE id=?',a.currentVersionId))).toEqual({content:'original'})
})
it('陈旧revision/version多字段与标签零写入',()=> {
  const a=create({tagNames:['Rust']})
  for(const condition of [{expectedRevision:9,expectedCurrentVersionId:a.currentVersionId},{expectedRevision:1,expectedCurrentVersionId:999}]) {
    expect(()=>updateAsset(ctx,a.id,condition,{content:'changed',name:'bad',notes:'bad',tagNames:['New']})).toThrow()
    expect(getAsset(ctx,a.id)).toEqual(a)
  }
})
it('正文必带条件，普通patch不得变code/storageType',()=> {
  const a=create()
  for(const [condition,patch] of [[{expectedRevision:1},{content:'new'}],[{expectedRevision:true},{name:'new'}],[{expectedRevision:1},{code:'bad'}],[{expectedRevision:1},{storageType:'file'}]]) {
    expect(()=>updateAsset(ctx,a.id,condition,patch)).toThrow()
  }
  expect(getAsset(ctx,a.id)).toEqual(a)
})
it('无效分类与标签同时更新原子失败',()=> {
  const a=create({tagNames:['Original']})
  expect(()=>updateAsset(ctx,a.id,{expectedRevision:1},{category:'ghost',name:'new',tagNames:['new']})).toThrow()
  expect(getAsset(ctx,a.id)).toEqual(a)
})
it('跨资产指针DB层拒绝',()=> {
  const a=create(); const b=create()
  expect(()=>ctx.write(s=>s.run('UPDATE asset SET current_version_id=? WHERE id=?',b.currentVersionId,a.id))).toThrow()
  expect(getAsset(ctx,a.id)).toEqual(a)
})
it('归档拒写，默认列表隐藏且only/include真实返回',()=> {
  const a=create()
  ctx.write(s=>s.run('UPDATE asset SET archived_at=? WHERE id=?','2026-01-01',a.id))
  expect(()=>updateAsset(ctx,a.id,{expectedRevision:1},{name:'new'})).toThrow()
  expect(listAssets(ctx).total).toBe(0)
  expect(listAssets(ctx,{archived:'only'}).items[0].id).toBe(a.id)
  expect(listAssets(ctx,{archived:'include'}).total).toBe(1)
})
it('标签归一复用并支持and/or过滤',()=> {
  const a=create({tagNames:[' Rust ','AI']}); create({tagNames:['rust']})
  expect(ctx.write(s=>s.get<{n:number}>('SELECT count(*) n FROM tag'))).toEqual({n:2})
  expect(listAssets(ctx,{tagIds:a.tags.map(t=>t.id),tagMode:'and'}).total).toBe(1)
  expect(listAssets(ctx,{tagIds:a.tags.map(t=>t.id),tagMode:'or'}).total).toBe(2)
})
it('分类子树与稳定分页返回实际items，不含正文',()=> {
  createCategory(ctx,{code:'parent',name:'Parent'})
  createCategory(ctx,{code:'child',name:'Child',parentCode:'parent'})
  const a=create({category:'child'}); const b=create({category:'parent'})
  ctx.write(s=>s.run('UPDATE asset SET updated_at=?','same'))
  expect(listAssets(ctx,{category:'parent',pageSize:1})).toMatchObject({total:2,items:[{id:b.id}]})
  const page2=listAssets(ctx,{category:'parent',pageSize:1,page:2})
  expect(page2.items[0].id).toBe(a.id)
  expect(page2.items[0]).not.toHaveProperty('currentContent')
})
it('严格分页与筛选校验',()=> {
  for(const q of [{page:true},{pageSize:201},{page:1.5},{tagIds:[true]},{archived:'bad'},{tagMode:'bad'},{storageType:'bad'}]) expect(()=>listAssets(ctx,q)).toThrow()
})
function snapshot(): unknown {
  return ctx.write(s => ({
    assets: s.all('SELECT * FROM asset ORDER BY id'),
    versions: s.all('SELECT * FROM asset_version ORDER BY id'),
    tags: s.all('SELECT * FROM tag ORDER BY id'),
    links: s.all('SELECT * FROM asset_tag ORDER BY asset_id,tag_id')
  }))
}
it('显式陈旧版本条件对metadata/no-op/标签全快照零修改',()=> {
  const a = create({tagNames:['First']})
  const b = updateAsset(ctx,a.id,{expectedRevision:a.revision,expectedCurrentVersionId:a.currentVersionId},{content:'v2'})
  const before = snapshot()
  for (const patch of [{name:'stale'}, {}, {name:b.name}, {name:'stale',notes:'stale',tagNames:['New']}]) {
    expect(()=>updateAsset(ctx,b.id,{expectedRevision:b.revision,expectedCurrentVersionId:a.currentVersionId},patch))
      .toThrow(expect.objectContaining({code:'VERSION_CONFLICT',details:{currentVersionId:b.currentVersionId}}))
    expect(snapshot()).toEqual(before)
  }
})
it('版本条件null与显式undefined精确校验，省略metadata条件兼容',()=> {
  const a=create()
  expect(()=>updateAsset(ctx,a.id,{expectedRevision:1,expectedCurrentVersionId:undefined},{}))
    .toThrow(expect.objectContaining({code:'BAD_REQUEST'}))
  expect(()=>updateAsset(ctx,a.id,{expectedRevision:1,expectedCurrentVersionId:null},{}))
    .toThrow(expect.objectContaining({code:'VERSION_CONFLICT'}))
  expect(updateAsset(ctx,a.id,{expectedRevision:1},{notes:'metadata'}).revision).toBe(2)
  const file=create({storageType:'file',content:''})
  expect(updateAsset(ctx,file.id,{expectedRevision:1,expectedCurrentVersionId:null},{notes:'file'}).revision).toBe(2)
})
it('分页null/bool/array/string拒绝，只有undefined默认1/50',()=> {
  for (const key of ['page','pageSize']) for (const value of [null,true,[], '1']) {
    expect(()=>listAssets(ctx,{[key]:value})).toThrow(expect.objectContaining({code:'BAD_REQUEST'}))
  }
  expect(listAssets(ctx,{})).toMatchObject({page:1,pageSize:50})
  expect(listAssets(ctx,{page:undefined,pageSize:undefined})).toMatchObject({page:1,pageSize:50})
})
it('带空白分类查询与规范code完全一致',()=> {
  create()
  expect(listAssets(ctx,{category:' inbox '})).toEqual(listAssets(ctx,{category:'inbox'}))
})
it('新版本来源取更新后的source，历史来源逐字不变',()=> {
  const a=create({source:{stage:'first'}})
  const b=updateAsset(ctx,a.id,{expectedRevision:1,expectedCurrentVersionId:a.currentVersionId},{content:'second',source:{stage:'second'}})
  expect(ctx.write(s=>s.all('SELECT version,source_json FROM asset_version WHERE asset_id=? ORDER BY version',a.id)))
    .toEqual([{version:1,source_json:'{"stage":"first"}'},{version:2,source_json:'{"stage":"second"}'}])
  const before=ctx.write(s=>s.all('SELECT * FROM asset_version WHERE asset_id=? ORDER BY version',a.id))
  const c=updateAsset(ctx,a.id,{expectedRevision:b.revision},{source:{stage:'metadata-only'}})
  expect(c.versionCount).toBe(2)
  expect(ctx.write(s=>s.all('SELECT * FROM asset_version WHERE asset_id=? ORDER BY version',a.id))).toEqual(before)
})
it('空间切换后读写均拒绝',async()=> {
  const a=create()
  await manager.beforeSpaceSwitch()
  expect(()=>getAsset(ctx,a.id)).toThrow()
  expect(()=>listAssets(ctx)).toThrow()
  expect(()=>create()).toThrow()
})
