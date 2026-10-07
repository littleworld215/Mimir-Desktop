import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset, updateAsset } from '../../../electron/assets/assetService'
import { exportAssets } from '../../../electron/assets/exchangeExport'
import { previewImport, commitImport } from '../../../electron/assets/exchangeImport'

let root: string, manager: AssetsStoreManager, ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-import-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p,o) => new Database(p,o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
const row = (code = 'text', extra: object = {}) => ({ code, name: code, category: 'inbox', storageType: 'inline_text', content: '  原文\r\n\n', ...extra })
const request = (items: unknown[], mode = 'skip', skipIndexes: number[] = []) => ({ raw: JSON.stringify({ assets: items }), mode, skipIndexes })
const commit = (r: ReturnType<typeof request>) => commitImport(ctx, { ...r, previewToken: previewImport(ctx,r).previewToken })
const state = () => ctx.write(s => ['asset','asset_version','asset_category','tag','asset_tag','asset_reference'].map(t => s.all(`SELECT * FROM ${t} ORDER BY rowid`)))

it('预览完全只读，中文路径缺失可见，提交重建树/标签与空白正文', () => {
  const r = request([row('text', { category: 'missing', categoryPath: ['研究','中文'], tags: [{ name: '资料', color: '#123456' }] })])
  const before = state(), p = previewImport(ctx,r)
  expect(p).toMatchObject({ created: 1, updated: 0, skipped: 0, canCommit: true })
  expect(p.categoriesMissing).toEqual(['研究 / 中文'])
  expect(state()).toEqual(before)
  const result = commitImport(ctx,{ ...r, previewToken: p.previewToken })
  expect(result.created).toBe(1)
  expect(getAsset(ctx,result.assetIds[0])).toMatchObject({ categoryPath: ['研究','中文'], currentContent: '  原文\r\n\n', tags: [{ name: '资料', color: '#123456' }] })
})
it('skip不改条目与关系；copy双方参见映射副本；overwrite相同正文不追加版本', () => {
  const initial = request([row('a',{ references: ['b'] }), row('b',{ references: ['a'] })])
  commit(initial)
  const before = state()
  expect(commit(request([row('a',{ content: 'changed', references: [] })])).skipped).toBe(1)
  expect(state()).toEqual(before)
  const copies = commit({ ...initial, mode: 'copy' })
  expect(copies.created).toBe(2)
  const edges = ctx.write(s=>s.all<{ source_asset_id: number; target_asset_id: number }>('SELECT * FROM asset_reference WHERE source_asset_id=?',copies.assetIds[0]))
  expect(edges[0].target_asset_id).toBe(copies.assetIds[1])
  const original = ctx.write(s=>s.get<{id:number}>('SELECT id FROM asset WHERE code=?','a'))!
  const count = getAsset(ctx,original.id).versionCount
  commit(request([row('a')],'overwrite'))
  expect(getAsset(ctx,original.id).versionCount).toBe(count)
  commit(request([row('a',{ content: '' })],'overwrite'))
  expect(getAsset(ctx,original.id)).toMatchObject({ currentContent: '', versionCount: count+1 })
})
it('文件覆盖保留版本指针/文件名，外链导入可用，JSON导出再导入闭环', () => {
  const file = createAsset(ctx,{ code: 'file', name: 'file', category: 'inbox', storageType: 'file' })
  ctx.write(s=>{ s.run("INSERT INTO asset_version(asset_id,version,content,changelog,source_json,file_path,file_name,created_at) VALUES (?,1,'','','{}','protected.bin','名字.pdf','now')",file.id); s.run('UPDATE asset SET current_version_id=(SELECT id FROM asset_version WHERE asset_id=?) WHERE id=?',file.id,file.id) })
  const prior = getAsset(ctx,file.id)
  expect(previewImport(ctx,request([row('file',{ storageType:'file',content:null })],'overwrite')).filesMissing).toBe(0)
  commit(request([row('file',{ storageType: 'file', content: null }),row('link',{ storageType: 'external_link', content: null, externalUrl: 'https://example.com' })],'overwrite'))
  expect(getAsset(ctx,file.id)).toMatchObject({ currentVersionId: prior.currentVersionId, currentFileName: '名字.pdf', versionCount: 1 })
  const r = { raw: exportAssets(ctx,{}).content, mode: 'copy', skipIndexes: [] }
  expect(commit(r).created).toBe(2)
})
it('行错误可显式跳过，但无效模板即使跳过仍整批拒绝', () => {
  const r = request([row('good'),row('bad',{ name: '' })])
  expect(previewImport(ctx,r)).toMatchObject({ canCommit: false, errors: [{ index: 2 }] })
  expect(()=>commit(r)).toThrow()
  expect(commit({ ...r, skipIndexes: [2] })).toMatchObject({ created: 1, skipped: 1 })
  const bad = request([row('cfg',{ templateConfig: { version: 2 } })],'skip',[1])
  expect(previewImport(ctx,bad).canCommit).toBe(false)
  expect(()=>commit(bad)).toThrow()
})
it('token绑定raw/模式/跳过/scope/标签名称及旧版本状态；陈旧零写', () => {
  commit(request([row('existing',{ tags: ['标签'] })]))
  const r = request([row('new')]), p = previewImport(ctx,r), prior = state()
  for (const changed of [{...r,mode:'copy'},{...r,raw:r.raw+' '},{...r,skipIndexes:[1]}]) {
    expect(()=>commitImport(ctx,{...changed,previewToken:p.previewToken})).toThrow(/预览/)
    expect(state()).toEqual(prior)
  }
  const cross = { ...ctx, scope: { workspaceId: 'B', spaceEpoch: 'B#1' } }
  expect(()=>commitImport(cross,{...r,previewToken:p.previewToken})).toThrow(/预览/)
  ctx.write(s=>s.run("UPDATE tag SET name='改名'"))
  const changed = state()
  expect(()=>commitImport(ctx,{...r,previewToken:p.previewToken})).toThrow(/预览/)
  expect(state()).toEqual(changed)
})
it('同批重复与缺参见在预览列出，不写自引用；畸形请求及路径参数拒绝', () => {
  expect(previewImport(ctx,request([row('same'),row('same')])).canCommit).toBe(false)
  const p = previewImport(ctx,request([row('self',{ references: ['self','absent'] })]))
  expect(p.referencesMissing).toContain('absent')
  commit(request([row('self',{ references: ['self','absent'] })]))
  expect(ctx.write(s=>s.all('SELECT * FROM asset_reference'))).toEqual([])
  for(const r of [{ raw:'null' },{raw:'{}'}, {raw:'[]',mode:'replace'}, {raw:'[]',skipIndexes:[0]}, {raw:'[]',path:'secret'}]) expect(()=>previewImport(ctx,r)).toThrow()
})
it('提交中SQL故障回滚资产/分类/标签/参见，无部分写入', () => {
  ctx.write(s=>s.run("CREATE TRIGGER fail_import BEFORE INSERT ON asset WHEN NEW.code='bad' BEGIN SELECT RAISE(ABORT,'fault'); END"))
  const r = request([row('good',{ category:'new',categoryPath:['新分类'],tags:['new'] }),row('bad')]), p = previewImport(ctx,r), before=state()
  expect(()=>commitImport(ctx,{...r,previewToken:p.previewToken})).toThrow()
  expect(state()).toEqual(before)
})
it('旧版本删除与仅关系变化均使预览陈旧，重放token不能增加复制', () => {
  const a=createAsset(ctx,{name:'a',code:'a',category:'inbox',storageType:'inline_text',content:'old'})
  const b=createAsset(ctx,{name:'b',code:'b',category:'inbox',storageType:'inline_text',content:'b'})
  updateAsset(ctx,a.id,{expectedRevision:a.revision,expectedCurrentVersionId:a.currentVersionId},{content:'new'})
  const r=request([row('a')],'copy'), p=previewImport(ctx,r)
  ctx.write(s=>s.run('DELETE FROM asset_version WHERE id=?',a.currentVersionId))
  expect(()=>commitImport(ctx,{...r,previewToken:p.previewToken})).toThrow(/预览/)
  const next=previewImport(ctx,r)
  ctx.write(s=>s.run('INSERT INTO asset_reference(source_asset_id,target_asset_id,created_at) VALUES (?,?,?)',a.id,b.id,'now'))
  expect(()=>commitImport(ctx,{...r,previewToken:next.previewToken})).toThrow(/预览/)
  const latest=previewImport(ctx,r)
  commitImport(ctx,{...r,previewToken:latest.previewToken})
  expect(()=>commitImport(ctx,{...r,previewToken:latest.previewToken})).toThrow(/预览/)
})
it('关系写故障回滚新增版本及元信息；only参见变化提升revision一次', () => {
  const original=commit(request([row('a'),row('b')]))
  const before=getAsset(ctx,original.assetIds[0])
  commit(request([row('a',{references:['b']})],'overwrite'))
  expect(getAsset(ctx,before.id)).toMatchObject({revision:before.revision+1,versionCount:before.versionCount})
  ctx.write(s=>s.run("CREATE TRIGGER fail_edge BEFORE INSERT ON asset_reference BEGIN SELECT RAISE(ABORT,'edge fault'); END"))
  const r=request([row('c',{references:['b'],tags:['new']})]), p=previewImport(ctx,r), prior=state()
  expect(()=>commitImport(ctx,{...r,previewToken:p.previewToken})).toThrow()
  expect(state()).toEqual(prior)
})
it('缺省code稳定生成；稀疏跳过、null来源、危险路径拒绝或列为行错误', () => {
  const r=request([{name:'no code',category:'inbox',content:'x'}])
  expect(previewImport(ctx,r).rows[0].targetCode).toBe(previewImport(ctx,r).rows[0].targetCode)
  const sparse=Array<number>(1)
  expect(()=>previewImport(ctx,{...r,skipIndexes:sparse})).toThrow()
  for(const extra of [{sourceJson:'null'},{sourceJson:'[]'},{filePath:'secret'},{tags:['x,y']},{externalUrl:'javascript:alert(1)',storageType:'external_link',content:null}]) expect(previewImport(ctx,request([row('bad',extra)])).canCommit).toBe(false)
})
it('100字符code截断复制仍满足标识语法，可导出再导入', () => {
  const code='a'.repeat(92)+'-'+'b'.repeat(7)
  commit(request([row(code)]))
  const copied=commit(request([row(code)],'copy'))
  const detail=getAsset(ctx,copied.assetIds[0])
  expect(detail.code).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  expect(detail.code.length).toBeLessThanOrEqual(100)
  const next={raw:exportAssets(ctx,{ids:[detail.id]}).content,mode:'copy',skipIndexes:[]}
  expect(previewImport(ctx,next).canCommit).toBe(true)
})
