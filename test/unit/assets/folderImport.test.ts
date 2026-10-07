import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { scanFolder, nextFolderFile, cancelFolder } from '../../../electron/assets/folderImport'
let root:string,folder:string,manager:AssetsStoreManager,ctx:AssetsContext
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),'assets-folder-'));folder=join(root,'input');mkdirSync(folder);manager=new AssetsStoreManager({active:()=>({id:'A',path:root}),epoch:()=> 'A#1'},(p,o)=>new Database(p,o));ctx=await manager.getForRequest(manager.context())})
afterEach(async()=>{await manager.close();rmSync(root,{recursive:true,force:true})})
it('逐文件真实进度；中文/同名加序号、内容与文件名保留，结束后无暂存',async()=>{
  mkdirSync(join(folder,'子目录'));writeFileSync(join(folder,'名字.txt'),'one');writeFileSync(join(folder,'子目录','名字.txt'),'two')
  const scan=scanFolder(ctx,folder,{category:'inbox',tagNames:['收集']});expect(scan.entries).toHaveLength(2);expect(scan.completed).toBe(0)
  const first=await nextFolderFile(ctx,{queueId:scan.queueId});expect(first.completed).toBe(1)
  const done=await nextFolderFile(ctx,{queueId:scan.queueId});expect(done.completed).toBe(2);expect(done.entries.map(e=>e.state)).toEqual(['done','done'])
  expect(ctx.write(s=>s.all('SELECT name FROM asset ORDER BY id'))).toEqual([{name:'名字.txt'},{name:'名字.txt (2)'}])
  expect(ctx.write(s=>s.all('SELECT file_name FROM asset_version ORDER BY id'))).toEqual([{file_name:'名字.txt'},{file_name:'名字.txt'}])
  expect(readdirSync(ctx.layout.stagingDir)).toEqual([])
  expect(done.entries.some(e=>'sourcePath' in e)).toBe(false)
})
it('扫描拒绝junction/链接；提交源丢失不建空壳，仅重试失败项',async()=>{
  const linked=join(folder,'link');symlinkSync(root,linked,'junction');writeFileSync(join(folder,'real.txt'),'x')
  const scan=scanFolder(ctx,folder,{});expect(scan.entries.find(e=>e.name==='link')?.state).toBe('failed')
  rmSync(join(folder,'real.txt'));const failed=await nextFolderFile(ctx,{queueId:scan.queueId});expect(failed.entries.filter(e=>e.state==='failed')).toHaveLength(2)
  expect(ctx.write(s=>s.all('SELECT id FROM asset'))).toEqual([])
  writeFileSync(join(folder,'real.txt'),'x');const retry=await nextFolderFile(ctx,{queueId:scan.queueId,retryFailed:true});expect(retry.entries.find(e=>e.name==='real.txt')?.state).toBe('done')
})
it('SQL失败同事务回滚新资产/标签/blob；取消及旧scope拒绝继续',async()=>{
  writeFileSync(join(folder,'bad.txt'),'x');const scan=scanFolder(ctx,folder,{tagNames:['new']})
  ctx.write(s=>s.run("CREATE TRIGGER fail_collected BEFORE INSERT ON asset_version BEGIN SELECT RAISE(ABORT,'failure'); END"))
  const failed=await nextFolderFile(ctx,{queueId:scan.queueId});expect(failed.entries[0].state).toBe('failed')
  expect(ctx.write(s=>s.all('SELECT id FROM asset'))).toEqual([]);expect(ctx.write(s=>s.all('SELECT id FROM tag'))).toEqual([])
  for(const dir of readdirSync(ctx.layout.filesDir))expect(readdirSync(join(ctx.layout.filesDir,dir))).toEqual([])
  expect(()=>cancelFolder({...ctx,scope:{workspaceId:'B',spaceEpoch:'B#1'}},{queueId:scan.queueId})).toThrow()
  cancelFolder(ctx,{queueId:scan.queueId});await expect(nextFolderFile(ctx,{queueId:scan.queueId})).rejects.toThrow()
})
