import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, statfsSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, totalmem, freemem, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
const cases: unknown[] = []
const budget = () => { const disk=statfsSync(tmpdir()); expect(disk.bavail*disk.bsize).toBeGreaterThanOrEqual(2*1024**3) }
const statistics=(samples:number[])=>{const sorted=[...samples].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return {min:sorted[0],median:sorted.length%2?sorted[mid]:(sorted[mid-1]!+sorted[mid]!)/2,max:sorted[sorted.length-1]}}
test.beforeAll(()=>{const file=process.env.MIMIR_IMPORT_SCAN_REPORT;if(!file||existsSync(file))throw Error('NEW_MIMIR_IMPORT_SCAN_REPORT_REQUIRED');budget()})
for (const [count,bytes] of [[100,4096],[1000,4096],[5000,4096],[100,1048576]]) test(`真实IPC合成${count}×${bytes}预览/提交五样本`,async()=>{
 test.setTimeout(600000)
 budget()
 const preview:number[]=[], imported:number[]=[], peaks:number[]=[]
 let fixtureSha256='',jsonBytes=0,electron=''
 for(let round=0;round<6;round++){
  const ctx=await launchApp({executablePath:process.env.MIMIR_E2E_PACKAGED})
  try{
   await gotoModule(ctx.page,'assets')
   const raw=JSON.stringify({assets:Array.from({length:count!},(_,index)=>({code:`bench-${index}`,name:`Bench ${index}`,category:'inbox',storageType:'inline_text',content:'x'.repeat(bytes!)}))})
   jsonBytes=Buffer.byteLength(raw);fixtureSha256=createHash('sha256').update(raw).digest('hex')
   const times=await ctx.page.evaluate(async({raw,count})=>{
    const api=window.electronAPI!.assets,s=await api.context();if(!s.ok)throw Error(s.message)
    const a=performance.now(),p=await api.previewImport({...s.context,raw,mode:'skip'}),b=performance.now()
    if(!p.ok||p.preview.created!==count||!p.preview.canCommit)throw Error('PREVIEW_MISMATCH')
    const result=await api.importJson({...s.context,raw,mode:'skip',previewToken:p.preview.previewToken}),c=performance.now()
    if(!result.ok||result.result.created!==count)throw Error('IMPORT_MISMATCH')
    const actual=await api.list(s.context);if(!actual.ok||actual.page.total!==count)throw Error('COUNT_MISMATCH')
    return {preview:b-a,import:c-b}
   },{raw,count:count!})
   const runtime=await ctx.app.evaluate(()=>({electron:process.versions.electron,rss:Math.max(process.resourceUsage().maxRSS*1024,process.memoryUsage().rss)}))
   electron=runtime.electron!;if(round){preview.push(times.preview);imported.push(times.import);peaks.push(runtime.rss)}
   console.log('NATIVE_IMPORT_PROGRESS',JSON.stringify({count,bytes,round,measured:round>0}))
  }finally{await ctx.cleanup()}
 }
 expect(preview).toHaveLength(5);expect(imported).toHaveLength(5)
 cases.push({caseId:`${count}x${bytes}`,electron,fixtureSha256,jsonBytes,warmup:1,samples:5,rssScope:'fresh Electron main-process cumulative high-water incl startup, not operation delta',measurements:[{operation:'preview',samplesMs:preview,statistics:statistics(preview),count,bytes:count!*bytes!,peakRssBytes:Math.max(...peaks)},{operation:'import',samplesMs:imported,statistics:statistics(imported),count,bytes:count!*bytes!,peakRssBytes:Math.max(...peaks)}]})
})
test('真实文件队列并发取消反馈与实际收尾、健康检查仅批间停止',async()=>{
 budget()
 const ctx=await launchApp({executablePath:process.env.MIMIR_E2E_PACKAGED})
 try{
  await gotoModule(ctx.page,'assets')
  const folder=join(ctx.tempHome.root,'ordinary');mkdirSync(folder)
  for(let index=0;index<5;index++)writeFileSync(join(folder,`${index}.bin`),Buffer.alloc(1024**2,120))
  await ctx.app.evaluate(({dialog},path)=>{dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[path]})) as never},folder)
  const first=await ctx.page.evaluate(async()=>{
   const api=window.electronAPI!.assets,s=await api.context();if(!s.ok)throw Error(s.message)
   const picker=await window.electronAPI!.showOpenDialog({properties:['openDirectory']}) as {filePaths:string[]}
   const a=performance.now(),scan=await api.scanFolder({...s.context,folderPath:picker.filePaths[0]!,category:'inbox'}),b=performance.now()
   if(!scan.ok||scan.queue.total!==5)throw Error('SCAN_MISMATCH')
   let actualSettledMs=0,cancelFeedbackMs=0
   const start=performance.now(),pending=api.nextFolderFile({...s.context,queueId:scan.queue.queueId}).then(result=>{actualSettledMs=performance.now()-start;return result})
   const cancelStart=performance.now(),cancel=api.cancelFolder({...s.context,queueId:scan.queue.queueId}).then(result=>{cancelFeedbackMs=performance.now()-cancelStart;return result})
   const [done,canceled]=await Promise.all([pending,cancel])
   if(!done.ok||done.queue.completed!==1||done.queue.entries.filter(e=>e.state==='done').length!==1)throw Error('COPY_MISMATCH')
   if(!canceled.ok&&canceled.code!=='BAD_REQUEST')throw Error('UNEXPECTED_CANCEL_ERROR')
   if(!canceled.ok){const after=await api.cancelFolder({...s.context,queueId:scan.queue.queueId});if(!after.ok)throw Error('CANCEL_AFTER_SETTLE_FAILED')}
   const old=await api.nextFolderFile({...s.context,queueId:scan.queue.queueId});if(old.ok||old.code!=='NOT_FOUND')throw Error('QUEUE_NOT_CANCELED')
   const again=await api.scanFolder({...s.context,folderPath:picker.filePaths[0]!,category:'inbox'});if(!again.ok)throw Error('FOLLOWUP_SCAN_FAILED');await api.cancelFolder({...s.context,queueId:again.queue.queueId})
   return {scope:s.context,assetId:done.queue.entries.find(e=>e.state==='done')!.assetId!,scanMs:b-a,cancelFeedbackMs,actualSettledMs,errorCode:canceled.ok?undefined:canceled.code}
  })
  const second=join(folder,'changed.bin');writeFileSync(second,Buffer.alloc(1024**2,121))
  await ctx.app.evaluate(({dialog},path)=>{dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[path]})) as never},second)
  const health=await ctx.page.evaluate(async({first,second})=>{
   const api=window.electronAPI!.assets,current=await api.get({...first.scope,assetId:first.assetId});if(!current.ok)throw Error(current.message)
   const picked=await window.electronAPI!.showOpenDialog({properties:['openFile']}) as {canceled:boolean;filePaths:string[]};if(picked.canceled||picked.filePaths[0]!==second)throw Error('FILE_PICK_MISMATCH')
   const version=await api.importFile({...first.scope,assetId:first.assetId,sourcePath:second,expectedRevision:current.asset.revision,expectedCurrentVersionId:current.asset.currentVersionId});if(!version.ok)throw Error(version.message)
   for(let index=0;index<60;index++){const created=await api.create({...first.scope,input:{name:`Empty ${index}`,category:'inbox',storageType:'file'}});if(!created.ok)throw Error(created.message)}
   let cancelFeedbackMs=0
   const start=performance.now(),task=api.inspectFileHealth(first.scope)
   await Promise.resolve();cancelFeedbackMs=performance.now()-start
   const result=await task,actualSettledMs=performance.now()-start
   if(!result.ok||result.batch.digestBaseline!=='not-established'||result.batch.items.length!==50||!result.batch.nextCursor)throw Error('HEALTH_BATCH_MISMATCH')
   const versions=await api.listVersions({...first.scope,assetId:first.assetId});if(!versions.ok||versions.page.total!==2)throw Error('VERSION_MISMATCH')
   return {cancelFeedbackMs,actualSettledMs,items:result.batch.items.length,openable:result.batch.items.filter(row=>row.status==='openable').length}
  },{first,second})
  expect(health.openable).toBe(2)
  cases.push({caseId:'cancel-diagnostics',operation:'folder-scan',count:5,bytes:5*1024**2,samplesMs:[first.scanMs],statistics:statistics([first.scanMs]),cancelFeedbackMs:first.cancelFeedbackMs,actualSettledMs:first.actualSettledMs,errorCode:first.errorCode,origin:'feedback from concurrent cancel IPC; settled from one-file import IPC start; no claim of interrupting synchronous scan/current copy'})
  cases.push({caseId:'health-cancel-diagnostic',operation:'file-health',count:61,totalFileVersions:2,checkedItems:health.items,samplesMs:[health.actualSettledMs],statistics:statistics([health.actualSettledMs]),cancelFeedbackMs:health.cancelFeedbackMs,actualSettledMs:health.actualSettledMs,cancelModel:'renderer intent stops subsequent batches only; actual current batch awaited; no backend abort API'})
 }finally{await ctx.cleanup()}
})
test.afterAll(()=>{
 const file=process.env.MIMIR_IMPORT_SCAN_REPORT;if(!file)throw Error('MIMIR_IMPORT_SCAN_REPORT_REQUIRED')
 writeFileSync(file,JSON.stringify({schemaVersion:1,node:process.version,cpu:cpus()[0]?.model,totalMemory:totalmem(),freeMemory:freemem(),dailyAppRunning:process.env.MIMIR_DAILY_APP_RUNNING??'not-observed',samplePolicy:'five valid samples per JSON case; no P95; single cancellation probes are diagnostics',cases},null,2)+'\n',{flag:'wx'})
})
