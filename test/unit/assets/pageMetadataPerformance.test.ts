import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { it, expect, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { summary } from '../../../electron/assets/assetRepository'
import * as metadata from '../../../electron/assets/pageMetadata'
import { listAssets } from '../../../electron/assets/assetService'

it('同机同库交替对照旧逐条与当前页批量读取，保存完整样本和DTO一致性', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assets-page-perf-'))
  const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p,o) => new Database(p,o))
  const optimized = metadata.pageSummaries
  const legacy: typeof optimized = (s,rows) => rows.map(row => summary(s,row))
  const spy = vi.spyOn(metadata,'pageSummaries')
  try {
    const ctx = await manager.getForRequest(manager.context())
    ctx.write(s => {
      s.run("INSERT INTO asset_category(code,name,parent_code,created_at) VALUES('root','Root',NULL,'now'),('leaf','Leaf','root','now')")
      s.run("INSERT INTO tag(id,name,normalized_name) VALUES(1,'科研','科研'),(2,'science','science')")
      for(let id=1; id<=5000; id++) {
        const token = id % 50 === 0 ? '科研 scientific 🧪😀🔬' : 'ordinary'
        const content = [...('背景材料 '.repeat(95)+token)].slice(0,500).join('').padEnd(500,'文')
        s.run("INSERT INTO asset(id,code,name,category,storage_type,created_at,updated_at) VALUES(?,?,?,'leaf','inline_text','now','now')",id,'asset-'+id,'Asset '+id)
        s.run("INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(?,?,1,'old body','now'),(?,?,2,?,'now')",id*2-1,id,id*2,id,content)
        s.run('UPDATE asset SET current_version_id=? WHERE id=?',id*2,id)
        s.run('INSERT INTO asset_tag(asset_id,tag_id) VALUES(?,1),(?,2)',id,id)
      }
    })
    const measurements = []
    for(const query of [{pageSize:50},{pageSize:200},{pageSize:50,q:'科研'},{pageSize:50,q:'scientific'},{pageSize:50,q:'🧪😀🔬'},{pageSize:50,q:'absent-token'}]) {
      spy.mockImplementation(legacy)
      const before = listAssets(ctx,query)
      spy.mockImplementation(optimized)
      expect(JSON.stringify(listAssets(ctx,query))).toBe(JSON.stringify(before))
      const samples = { before: [] as number[], after: [] as number[] }
      const measure = (old:boolean,record:boolean) => {
        spy.mockImplementation(old ? legacy : optimized)
        const start=performance.now()
        listAssets(ctx,query)
        if(record) samples[old?'before':'after'].push(Number((performance.now()-start).toFixed(3)))
      }
      for(let i=0;i<5;i++){measure(true,false);measure(false,false)}
      for(let i=0;i<30;i++){measure(i%2===0,true);measure(i%2!==0,true)}
      const percentile = (values:number[]) => {
        const ordered=[...values].sort((a,b)=>a-b)
        return {p50:ordered[Math.ceil(ordered.length*.5)-1],p95:ordered[Math.ceil(ordered.length*.95)-1]}
      }
      measurements.push({query,count:before.total,before:percentile(samples.before),after:percentile(samples.after),beforeSamplesMs:samples.before,afterSamplesMs:samples.after})
    }
    const report={node:process.version,sqlite:ctx.write(s=>s.get('SELECT sqlite_version() version')),rows:5000,versionsPerAsset:2,tagsPerAsset:2,categoryDepth:2,warmup:5,samples:30,measurements}
    console.log('PAGE_METADATA_PERFORMANCE',JSON.stringify(report))
    if(process.env.MIMIR_PAGE_METADATA_REPORT) writeFileSync(process.env.MIMIR_PAGE_METADATA_REPORT,JSON.stringify(report,null,2))
  } finally {spy.mockRestore();await manager.close();rmSync(root,{recursive:true,force:true})}
},60000)
