import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('real Electron exchange IPC: preview readonly, roundtrip, stale rejection, copy edges and reopen SQLite', async () => {
  const launched=await launchApp()
  try {
    await gotoModule(launched.page,'assets')
    const result=await launched.page.evaluate(async () => {
      const api=window.electronAPI!.assets, context=await api.context()
      if (!context.ok) throw new Error(context.message)
      const scope=context.context
      const a=await api.create({...scope,input:{code:'a',name:'中文原文',category:'inbox',storageType:'inline_text',content:'  原文\r\n\n',tagNames:['资料']}})
      const b=await api.create({...scope,input:{code:'b',name:'文件',category:'inbox',storageType:'file'}})
      if (!a.ok || !b.ok) throw new Error('create failed')
      await api.addReference({...scope,sourceAssetId:a.asset.id,targetAssetId:b.asset.id,expectedRevision:a.asset.revision})
      const output=await api.exportAssets({...scope,ids:[a.asset.id,b.asset.id],format:'json'})
      if (!output.ok) throw new Error(output.message)
      const r={...scope,raw:output.result.content,mode:'copy' as const}
      const preview=await api.previewImport(r), before=await api.list(scope)
      if (!preview.ok) throw new Error(preview.message)
      const imported=await api.importJson({...r,previewToken:preview.preview.previewToken})
      const replay=await api.importJson({...r,previewToken:preview.preview.previewToken})
      if (!imported.ok) throw new Error(imported.message)
      const copied=await api.get({...scope,assetId:imported.result.assetIds[0]})
      const refs=await api.references({...scope,assetId:imported.result.assetIds[0]})
      const wrongScope=await api.previewImport({...r,spaceEpoch:'wrong'})
      const after=await api.list(scope)
      return {preview,before,imported,replay,copied,refs,wrongScope,after}
    })
    expect(result.preview).toMatchObject({ok:true,preview:{created:2,canCommit:true}})
    expect(result.before).toMatchObject({ok:true,page:{total:2}})
    expect(result.after).toMatchObject({ok:true,page:{total:4}})
    expect(result.replay).toMatchObject({ok:false,code:'PREVIEW_STALE'})
    expect(result.wrongScope).toMatchObject({ok:false,code:'SPACE_CHANGED'})
    expect(result.copied).toMatchObject({ok:true,asset:{currentContent:'  原文\r\n\n'}})
    if (!result.imported.ok || !result.refs.ok) throw new Error('result failed')
    expect(result.refs.references.references[0].id).toBe(result.imported.result.assetIds[1])
    await launched.app.close()
    const store=JSON.parse(readFileSync(join(launched.tempHome.home,'.mimir','store.json'),'utf8'))
    const space=store['workspaces:list'].find((s:{id:string})=>s.id===store.activeWorkspaceId)
    const db=new Database(join(space.path,'.mimir','assets','assets.db'),{readonly:true})
    try {
      expect(db.pragma('integrity_check',{simple:true})).toBe('ok')
      expect(db.prepare('SELECT count(*) n FROM asset').get()).toEqual({n:4})
      expect(db.prepare('SELECT count(*) n FROM asset_reference').get()).toEqual({n:2})
      expect(db.prepare('SELECT content FROM asset_version WHERE asset_id=?').get(result.imported.result.assetIds[0])).toEqual({content:'  原文\r\n\n'})
    } finally { db.close() }
  } finally { await launched.cleanup() }
})
