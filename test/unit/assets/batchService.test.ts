import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset } from '../../../electron/assets/assetService'
import { previewBatch, commitBatch } from '../../../electron/assets/batchService'

let root:string,manager:AssetsStoreManager,ctx:AssetsContext
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),'assets-batch-'));manager=new AssetsStoreManager({active:()=>({id:'A',path:root}),epoch:()=> 'A#1'},(p,o)=>new Database(p,o));ctx=await manager.getForRequest(manager.context())})
afterEach(async()=>{await manager.close();rmSync(root,{recursive:true,force:true})})
const create=(name:string)=>createAsset(ctx,{name,category:'inbox',storageType:'inline_text',content:'  历史\r\n\n',tagNames:['旧标签']})
const snapshot=()=>ctx.write(s=>['asset','asset_version','asset_category','tag','asset_tag','asset_reference'].map(t=>s.all(`SELECT * FROM ${t} ORDER BY rowid`)))
it('预览只读；同时改分类/加移标签，正文版本与文件元数据不动',()=>{
  const a=create('a'),b=create('b'), before=snapshot()
  const request={assets:[a,b].map(a=>({assetId:a.id,expectedRevision:a.revision})),category:'prompt',addTagNames:['新标签'],removeTagIds:[a.tags[0].id]}
  const p=previewBatch(ctx,request)
  expect(p.rows).toHaveLength(2);expect(snapshot()).toEqual(before)
  expect(commitBatch(ctx,{...request,previewToken:p.previewToken})).toMatchObject({changed:2})
  for(const asset of [a,b]) expect(getAsset(ctx,asset.id)).toMatchObject({category:'prompt',revision:asset.revision+1,currentVersionId:asset.currentVersionId,currentContent:'  历史\r\n\n',tags:[{name:'新标签'}]})
})
it('任一陈旧revision/缺资产/归档资产整批拒绝，旧token、改条件、跨scope零写',()=>{
  const a=create('a'),b=create('b'), request={assets:[a,b].map(a=>({assetId:a.id,expectedRevision:a.revision})),category:'prompt'},p=previewBatch(ctx,request)
  ctx.write(s=>s.run('UPDATE asset SET revision=revision+1 WHERE id=?',b.id));const before=snapshot()
  expect(()=>commitBatch(ctx,{...request,previewToken:p.previewToken})).toThrow();expect(snapshot()).toEqual(before)
  for(const change of [{assets:[{assetId:999,expectedRevision:1}],category:'prompt'},{assets:[{assetId:b.id,expectedRevision:b.revision}],category:'prompt'}]) expect(()=>previewBatch(ctx,change)).toThrow()
  const next={...request,assets:[{assetId:a.id,expectedRevision:a.revision}]},q=previewBatch(ctx,next)
  expect(()=>commitBatch(ctx,{...next,category:'rule',previewToken:q.previewToken})).toThrow(/预览/)
  expect(()=>commitBatch({...ctx,scope:{workspaceId:'B',spaceEpoch:'B#1'}},{...next,previewToken:q.previewToken})).toThrow(/预览/)
  ctx.write(s=>s.run('UPDATE asset SET archived_at=? WHERE id=?','now',a.id));expect(()=>previewBatch(ctx,next)).toThrow()
})
it('无变化幂等，不提升revision；500选择不截断；稀疏重复未知参数拒绝',()=>{
  const a=create('a'),request={assets:[{assetId:a.id,expectedRevision:a.revision}],category:'inbox',addTagNames:['旧标签']},p=previewBatch(ctx,request)
  expect(commitBatch(ctx,{...request,previewToken:p.previewToken}).changed).toBe(0);expect(getAsset(ctx,a.id).revision).toBe(a.revision)
  for(const extra of [{assets:[]},{assets:Array(1)},{assets:[request.assets[0],request.assets[0]]},{assets:Array(501).fill(request.assets[0])},{path:'secret'},{category:'missing'},{removeTagIds:Array(1)}]) expect(()=>previewBatch(ctx,{...request,...extra})).toThrow()
})
it('分类/共享标签变化令牌失效；SQL失败整批回滚',()=>{
  const a=create('a'),b=create('b'),request={assets:[a,b].map(a=>({assetId:a.id,expectedRevision:a.revision})),addTagNames:['新']},p=previewBatch(ctx,request)
  ctx.write(s=>s.run('UPDATE tag SET name=? WHERE id=?','改名',a.tags[0].id));expect(()=>commitBatch(ctx,{...request,previewToken:p.previewToken})).toThrow(/预览/)
  ctx.write(s=>s.run(`CREATE TRIGGER batch_failure BEFORE UPDATE ON asset WHEN NEW.id=${b.id} BEGIN SELECT RAISE(ABORT,'failure'); END`))
  const next=previewBatch(ctx,request),before=snapshot();expect(()=>commitBatch(ctx,{...request,previewToken:next.previewToken})).toThrow();expect(snapshot()).toEqual(before)
})
it('500个不同资产全部预览和提交，无分页或截断',()=>{
  ctx.write(s=>{for(let i=1;i<=500;i++)s.run("INSERT INTO asset(code,name,category,storage_type,created_at,updated_at) VALUES (?,?,'inbox','inline_text','now','now')",`batch-${i}`,`资产${i}`)})
  const request={assets:ctx.write(s=>s.all<{assetId:number;expectedRevision:number}>('SELECT id assetId,revision expectedRevision FROM asset ORDER BY id')),category:'prompt'}
  const p=previewBatch(ctx,request);expect(p.rows).toHaveLength(500)
  expect(commitBatch(ctx,{...request,previewToken:p.previewToken}).changed).toBe(500)
  expect(ctx.write(s=>s.get('SELECT count(*) n FROM asset WHERE category=? AND revision=2','prompt'))).toEqual({n:500})
})
