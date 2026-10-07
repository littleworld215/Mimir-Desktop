import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, it, expect } from 'vitest'
import { ASSETS_V1_DDL, ASSETS_I2_DDL } from '../../../electron/assets/schema'
import { assetsLayout } from '../../../electron/assets/paths'
import { openAssetsStore } from '../../../electron/assets/store'
import { initializeSchema } from '../../../electron/assets/migrations'
let root:string
const connections:Database.Database[]=[]
const factory=(p:string,o:Database.Options)=>new Database(p,o)
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'assets-i4-schema-'))})
afterEach(()=>{for(const db of connections.splice(0))if(db.open)db.close();rmSync(root,{recursive:true,force:true})})
function old(){const layout=assetsLayout(root);mkdirSync(layout.root,{recursive:true});const db=factory(layout.dbPath,{});connections.push(db);for(const ddl of [...ASSETS_V1_DDL,...ASSETS_I2_DDL])db.exec(ddl);db.exec("INSERT INTO asset_category(code,name,created_at) VALUES ('inbox','自定义名','now'); INSERT INTO asset(code,name,category,storage_type,created_at,updated_at,is_favorite,last_used_at) VALUES ('a','原文','inbox','inline_text','now','now',1,'old'); INSERT INTO asset_version(asset_id,version,content,created_at) VALUES (1,1,' 空白\r\n\n','now'); UPDATE asset SET current_version_id=1; PRAGMA user_version=2");return{layout,db}}
it('schema2先备份再升级3；所有历史/收藏/最近/FTS/用户分类不变，重开不重复备份',async()=>{
  const {layout,db}=old(),tables=['asset_category','asset','asset_version','asset_fts'],before=tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all());db.close()
  const store=await openAssetsStore({root,databaseFactory:factory});try{expect(store.db.pragma('user_version',{simple:true})).toBe(3);expect(tables.map(t=>store.db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);expect(store.db.prepare('SELECT * FROM saved_filter').all()).toEqual([])}finally{store.close()}
  const backups=readdirSync(layout.backupsDir);expect(backups).toHaveLength(1);const snap=factory(join(layout.backupsDir,backups[0]),{readonly:true});try{expect(snap.pragma('user_version',{simple:true})).toBe(2);expect(tables.map(t=>snap.prepare(`SELECT * FROM ${t}`).all())).toEqual(before)}finally{snap.close()}
  const reopen=await openAssetsStore({root,databaseFactory:factory});reopen.close();expect(readdirSync(layout.backupsDir)).toEqual(backups)
})
it('升级DDL故障全部回滚，版本仍2，无半建筛选表；损坏v2预检拒绝',async()=>{
  const {db}=old(),exec=db.exec.bind(db);db.exec=((sql:string)=>{if(sql.includes('CREATE INDEX idx_saved_filter'))throw Error('DDL fault');return exec(sql)}) as typeof db.exec
  expect(()=>initializeSchema(db,()=>new Date())).toThrow();expect(db.pragma('user_version',{simple:true})).toBe(2);expect(db.prepare("SELECT name FROM sqlite_master WHERE name='saved_filter'").get()).toBeUndefined()
  db.exec=exec;db.exec('DROP TRIGGER trg_asset_fts_update');db.close();await expect(openAssetsStore({root,databaseFactory:factory})).rejects.toMatchObject({code:'STORE_CORRUPT'})
})
