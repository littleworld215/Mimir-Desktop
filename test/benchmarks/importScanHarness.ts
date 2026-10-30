import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, statfsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { tmpdir, cpus, totalmem, freemem } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { expect } from 'vitest'
import { AssetsStoreManager } from '../../electron/assets/store'
import { previewImport, commitImport } from '../../electron/assets/exchangeImport'
import { scanFolder, cancelFolder } from '../../electron/assets/folderImport'
import { inspectFileHealthBatch } from '../../electron/assets/fileHealth'
import { isManagedAssetPath } from '../../electron/assets/managedPaths'
import type { AssetsContext } from '../../electron/assets/types'
import type { FileHealthCursor } from '../../shared/assetsFileHealthContracts'

export interface ImportScanMeasurement { caseId: string; operation: 'preview'|'import'|'folder-scan'|'file-health'; count: number; bytes: number; samplesMs: number[]; peakRssBytes: number; cancelFeedbackMs?: number; actualSettledMs?: number; errorCode?: string }
export function statistics(samples: number[]) {
  if (!samples.length || samples.some(value=>!Number.isFinite(value)||value<0)) throw Error('INVALID_SAMPLES')
  const sorted=[...samples].sort((a,b)=>a-b), middle=Math.floor(sorted.length/2)
  return {min:sorted[0]!,median:sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2,max:sorted[sorted.length-1]!,...(samples.length>=20?{p95:sorted[Math.ceil(sorted.length*.95)-1]}:{})}
}
const freeBytes=()=>{const disk=statfsSync(tmpdir());return disk.bavail*disk.bsize}
const budget=()=>{if(freeBytes()<2*1024**3)throw Error('DISK_BUDGET_UNDER_2GIB')}
const peak=()=>Math.max(process.resourceUsage().maxRSS*1024,process.memoryUsage().rss)
async function fixture() {
  budget()
  const root=mkdtempSync(join(tmpdir(),'mimir-import-scan-')), space=join(root,'home','space')
  mkdirSync(space,{recursive:true})
  const manager=new AssetsStoreManager({active:()=>({id:'benchmark',path:space}),epoch:()=> 'benchmark#1'},(file,options)=>new Database(file,options))
  const ctx=await manager.getForRequest(manager.context())
  return {root,space,ctx,clean:async()=>{
    await manager.close()
    if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('mimir-import-scan-')||lstatSync(root).isSymbolicLink()||resolve(realpathSync(root))!==resolve(root))throw Error('UNSAFE_BENCHMARK_CLEANUP')
    rmSync(root,{recursive:true,force:true})
  }}
}
const count=(ctx:AssetsContext)=>ctx.write(s=>s.get<{count:number}>('SELECT count(*) count FROM asset')!.count)
export async function correctness() {
  const f=await fixture()
  try{
    const raw=JSON.stringify([{code:'valid',name:'valid',category:'inbox',content:'synthetic',storageType:'inline_text'},{code:'invalid',name:'invalid',category:'inbox',templateConfig:{bad:true}}])
    const input={raw,mode:'skip'}, preview=previewImport(f.ctx,input)
    expect(preview.canCommit).toBe(false)
    expect(()=>commitImport(f.ctx,{...input,previewToken:preview.previewToken})).toThrow()
    expect(count(f.ctx)).toBe(0)
    const guard=(file:string)=>{if(isManagedAssetPath(file,f.space))throw Error('PATH_REJECTED')}
    expect(()=>scanFolder(f.ctx,f.ctx.layout.filesDir,{},guard)).toThrow('PATH_REJECTED')
    const source=join(f.root,'ordinary');mkdirSync(source);writeFileSync(join(source,'good.bin'),'x');writeFileSync(join(source,'gone.bin'),'x')
    const queue=scanFolder(f.ctx,source,{},file=>{guard(file);if(file.endsWith('gone.bin'))unlinkSync(file)})
    expect(queue.entries.map(e=>e.state).sort()).toEqual(['failed','pending']);cancelFolder(f.ctx,{queueId:queue.queueId})
    const health=await inspectFileHealthBatch(f.ctx,{})
    expect(health.digestBaseline).toBe('not-established');expect(health.items.length).toBeLessThanOrEqual(50)
  }finally{await f.clean()}
}
function fileFixture(ctx:AssetsContext,source:string,count:number,bytes:number) {
  mkdirSync(source);const data=Buffer.alloc(bytes,120), date='2026-10-30T00:00:00.000Z'
  ctx.write(s=>{
    for(let index=0;index<count;index++){
      writeFileSync(join(source,`${index}.bin`),data)
      s.run("INSERT INTO asset(code,name,category,storage_type,created_at,updated_at) VALUES(?,?,'inbox','file',?,?)",`file-${index}`,`File ${index}`,date,date)
      const id=s.get<{id:number}>('SELECT last_insert_rowid() id')!.id
      mkdirSync(join(ctx.layout.filesDir,String(id)),{recursive:true})
      for(const version of [1,2]){
        const path=`files/${id}/v${version}.bin`;writeFileSync(join(ctx.layout.root,path),data)
        s.run('INSERT INTO asset_version(asset_id,version,file_path,created_at) VALUES(?,?,?,?)',id,version,path,date)
        if(version===2)s.run('UPDATE asset SET current_version_id=last_insert_rowid() WHERE id=?',id)
      }
    }
  })
}
export async function runCase(rowCount:number,bodyBytes:number) {
  const caseId=`${rowCount}x${bodyBytes}`, operations=['preview','import','folder-scan','file-health'] as const
  const records=operations.map(operation=>({caseId,operation,count:rowCount,bytes:rowCount*bodyBytes,samplesMs:[],peakRssBytes:0} as ImportScanMeasurement))
  const setupMs:number[]=[], actualJsonBytes:number[]=[]
  let digest='',sqlite=''
  for(let round=0;round<6;round++){
    const f=await fixture()
    try{
      const setupStart=performance.now(), raw=JSON.stringify({assets:Array.from({length:rowCount},(_,index)=>({code:`bench-${index}`,name:`Bench ${index}`,category:'inbox',storageType:'inline_text',content:'x'.repeat(bodyBytes)}))})
      actualJsonBytes.push(Buffer.byteLength(raw));expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(200*1024**2)
      const hash=createHash('sha256').update(raw).digest('hex');if(digest)expect(hash).toBe(digest);digest=hash
      const input={raw,mode:'skip'}, measure=<T>(operation:()=>T,index:number):T=>{const start=performance.now(),result=operation();if(round)records[index]!.samplesMs.push(performance.now()-start);return result}
      setupMs.push(performance.now()-setupStart)
      const preview=measure(()=>previewImport(f.ctx,input),0);expect(preview.canCommit).toBe(true);expect(preview.created).toBe(rowCount);expect(count(f.ctx)).toBe(0)
      const imported=measure(()=>commitImport(f.ctx,{...input,previewToken:preview.previewToken}),1)
      const actual=f.ctx.write(s=>s.get<{count:number;bytes:number}>('SELECT COUNT(*) count,SUM(length(content)) bytes FROM asset_version'))
      expect(actual).toEqual({count:rowCount,bytes:rowCount*bodyBytes});expect(imported.created).toBe(rowCount)
      const startFiles=performance.now(),source=join(f.root,'source');fileFixture(f.ctx,source,rowCount,bodyBytes);setupMs[round]!+=performance.now()-startFiles
      const guard=(file:string)=>{if(isManagedAssetPath(file,f.space))throw Error('PATH_REJECTED')}
      const queue=measure(()=>scanFolder(f.ctx,source,{},guard),2);expect(queue.total).toBe(rowCount);expect(queue.entries.every(e=>e.state==='pending')).toBe(true);cancelFolder(f.ctx,{queueId:queue.queueId})
      let cursor:FileHealthCursor|undefined,versions=0
      const healthStart=performance.now()
      do{const batch=await inspectFileHealthBatch(f.ctx,cursor?{cursor}:{});expect(batch.digestBaseline).toBe('not-established');expect(batch.items.length).toBeLessThanOrEqual(50);expect(batch.items.every(item=>item.status==='openable')).toBe(true);versions+=batch.items.length;cursor=batch.nextCursor??undefined}while(cursor)
      if(round)records[3]!.samplesMs.push(performance.now()-healthStart)
      expect(versions).toBe(rowCount*2)
      sqlite=f.ctx.write(s=>s.get<{version:string}>('SELECT sqlite_version() version')!.version)
      for(const record of records)record.peakRssBytes=Math.max(record.peakRssBytes,peak())
      console.log('IMPORT_SCAN_PROGRESS',JSON.stringify({caseId,round,measured:round>0,versions}))
    }finally{await f.clean()}
  }
  return {caseId,fixtureSha256:digest,sqlite,warmup:1,samples:5,actualJsonBytes,fixtureGenerationMs:setupMs,versionsPerFileAsset:2,totalFileVersions:rowCount*2,measurements:records.map(record=>({...record,statistics:statistics(record.samplesMs)}))}
}
export function writeReport(file:string,cases:unknown[]) {
  if(!file)throw Error('MIMIR_IMPORT_SCAN_REPORT_REQUIRED')
  const report={schemaVersion:1,node:process.version,platform:process.platform,cpu:cpus()[0]?.model,totalMemory:totalmem(),freeMemory:freemem(),availableDiskBytes:freeBytes(),dailyAppRunning:process.env.MIMIR_DAILY_APP_RUNNING??'not-observed',rssScope:'process cumulative high-water, not operation delta',isolation:'explicit fresh temporary roots and normal test logger isolation; HOME/TEMP unchanged',fixtureScope:'synthetic repeated ASCII bodies and ordinary files, no real research or model',cases}
  writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
}
