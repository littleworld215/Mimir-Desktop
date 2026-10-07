import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ASSETS_V2_DDL, ASSETS_SCHEMA_VERSION } from '../../electron/assets/schema'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

for(const runtime of ['development',...(process.env.MIMIR_E2E_PACKAGED?['packaged']:[])]) {
test(`real Electron schema2 upgrade keeps favorites, recent, current history and snapshot (${runtime})`,async()=>{
  let dir='',before:unknown
  const launched=await launchApp({executablePath:runtime==='packaged'?process.env.MIMIR_E2E_PACKAGED:undefined,transformSeed:seed=>{
    dir=join(seed.workspaces[0]!.path,'.mimir','assets');mkdirSync(dir,{recursive:true})
    const db=new Database(join(dir,'assets.db'))
    try{
      for(const ddl of ASSETS_V2_DDL)db.exec(ddl)
      db.exec("INSERT INTO asset_category(code,name,created_at) VALUES ('inbox','旧分类','now'); INSERT INTO asset(code,name,category,storage_type,is_favorite,last_used_at,created_at,updated_at) VALUES ('old','取用旧原文','inbox','inline_text',1,'2026-01-01T00:00:00.000Z','now','now'); INSERT INTO asset_version(asset_id,version,content,created_at) VALUES (1,1,' 多行\r\n\n','now'); UPDATE asset SET current_version_id=1; PRAGMA user_version=2")
      before=db.prepare('SELECT * FROM asset_version').all()
    }finally{db.close()}
    return seed
  }})
  try{
    await gotoModule(launched.page,'assets')
    await expect(launched.page.getByRole('button',{name:/取用旧原文/})).toBeVisible()
    const result=await launched.page.evaluate(async()=>{const api=window.electronAPI!.assets,c=await api.context();if(!c.ok)throw Error(c.message);return api.list({...c.context,view:'favorites'})})
    expect(result).toMatchObject({ok:true,page:{total:1,items:[{isFavorite:1,lastUsedAt:'2026-01-01T00:00:00.000Z'}]}})
    await launched.app.close()
    const db=new Database(join(dir,'assets.db'),{readonly:true})
    try{expect(db.pragma('user_version',{simple:true})).toBe(ASSETS_SCHEMA_VERSION);expect(db.prepare('SELECT * FROM asset_version').all()).toEqual(before);expect(db.prepare('SELECT * FROM saved_filter').all()).toEqual([]);expect(db.pragma('integrity_check',{simple:true})).toBe('ok')}finally{db.close()}
    const backups=readdirSync(join(dir,'backups'));expect(backups).toHaveLength(1)
    const snapshot=new Database(join(dir,'backups',backups[0]),{readonly:true})
    try{expect(snapshot.pragma('user_version',{simple:true})).toBe(2);expect(snapshot.prepare('SELECT * FROM asset_version').all()).toEqual(before)}finally{snapshot.close()}
  }finally{await launched.cleanup()}
})
}
