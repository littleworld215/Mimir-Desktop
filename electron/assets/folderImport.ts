/** A scope-bound queue grants only scanned ordinary files. Each next call imports one file atomically; UI controls pause/continue. */
import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { AssetFolderOptions, AssetFolderQueue } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext } from './types'
import { importFile, sourceIsLink } from './fileService'
import { assertAssetCode, assertAssetName, assertTagCount, assertTagName } from './validation'
import { replaceTags } from './tagRepository'
import { selectCategory } from './categoryRepository'

interface Entry { dto:AssetFolderQueue['entries'][number];path?:string;stat?:Stats }
interface Queue {scope:string;root:string;entries:Entry[];options:AssetFolderOptions;busy:boolean;check:(p:string)=>void}
const queues=new Map<string,Queue>()
function scope(ctx:AssetsContext){return JSON.stringify(ctx.scope)}
function bad(message='队列参数非法。'):never{throw new AssetsStoreError('BAD_REQUEST',message)}
function options(input:unknown):AssetFolderOptions{
  if(!input||typeof input!=='object'||Array.isArray(input))bad()
  const v=input as Record<string,unknown>
  if(Object.keys(v).some(k=>!['category','tagNames'].includes(k)))bad()
  if(v.tagNames!==undefined&&!Array.isArray(v.tagNames))bad()
  const tagNames=Array.from((v.tagNames??[]) as unknown[],assertTagName);assertTagCount(tagNames.length)
  return {category:assertAssetCode(v.category??'inbox'),tagNames}
}
function result(id:string,q:Queue):AssetFolderQueue{return {queueId:id,total:q.entries.length,completed:q.entries.filter(e=>e.dto.state==='done'||e.dto.state==='failed').length,entries:q.entries.map(e=>({...e.dto}))}}
function get(ctx:AssetsContext,input:unknown,allowRetry=false):[string,Queue,boolean]{
  ctx.assertCurrent()
  if(!input||typeof input!=='object'||Array.isArray(input))bad()
  const v=input as Record<string,unknown>
  if(Object.keys(v).some(k=>!['queueId',...(allowRetry?['retryFailed']:[])].includes(k))||typeof v.queueId!=='string'||(v.retryFailed!==undefined&&typeof v.retryFailed!=='boolean'))bad()
  const q=queues.get(v.queueId)
  if(!q)throw new AssetsStoreError('NOT_FOUND','队列已取消或过期。')
  if(q.scope!==scope(ctx))throw new AssetsStoreError('SPACE_CHANGED','队列属于旧科研空间。')
  if(q.busy)bad('当前文件仍在导入，请稍候。')
  return [v.queueId,q,v.retryFailed===true]
}
export function scanFolder(ctx:AssetsContext,folder:string,input:unknown,check:(p:string)=>void=()=>{}):AssetFolderQueue{
  ctx.assertCurrent();const config=options(input),root=resolve(folder)
  ctx.write(s=>{if(!selectCategory(s,config.category as string))throw new AssetsStoreError('BAD_CATEGORY','分类不存在。')})
  check(root)
  const meta=lstatSync(root)
  if(!meta.isDirectory()||sourceIsLink(meta,realpathSync(root),root))throw new AssetsStoreError('PATH_REJECTED','请选择真实文件夹，不能使用链接。')
  for(const [id,q] of queues)if(q.scope!==scope(ctx)&&!q.busy)queues.delete(id)
  if(queues.size>=10)bad('待处理队列过多，请先取消旧队列。')
  const entries:Entry[]=[]
  function walk(dir:string,depth:number){
    for(const name of readdirSync(dir).sort()){
      if(entries.length>=10000)bad('文件夹超过10000项，请分批选择子目录。')
      const path=join(dir,name),display=path.slice(root.length+1)
      try{
        if(path===ctx.layout.root||path.startsWith(ctx.layout.root+sep))throw new Error('托管数据不可作为导入素材。')
        check(path)
        const stat=lstatSync(path)
        if(sourceIsLink(stat,realpathSync(path),path))throw new Error('链接或junction已拒绝。')
        if(stat.isDirectory()){if(depth>=64)throw new Error('目录过深，请单独选择。');walk(path,depth+1)}
        else if(stat.isFile())entries.push({path,stat,dto:{index:entries.length+1,name:display,state:'pending'}})
        else throw new Error('不是普通文件。')
      }catch(error){if(error instanceof AssetsStoreError&&error.code==='BAD_REQUEST')throw error;entries.push({dto:{index:entries.length+1,name:display,state:'failed',error:error instanceof Error?error.message:'读取失败。'}})}
    }
  }
  walk(root,0);ctx.assertCurrent()
  const id=randomUUID(),q:Queue={scope:scope(ctx),root,entries,options:config,busy:false,check};queues.set(id,q);return result(id,q)
}
export async function nextFolderFile(ctx:AssetsContext,input:unknown):Promise<AssetFolderQueue>{
  const [id,q,retry]=get(ctx,input,true)
  if(retry)for(const e of q.entries)if(e.path&&e.dto.state==='failed'){e.dto.state='pending';delete e.dto.error;try{e.stat=lstatSync(e.path)}catch{/* next yields an explicit failure. */}}
  const e=q.entries.find(e=>e.dto.state==='pending')
  if(!e)return result(id,q)
  q.busy=true;e.dto.state='processing'
  try{
    const path=e.path as string
    q.check(q.root);q.check(path)
    const meta=lstatSync(path)
    if(!meta.isFile()||sourceIsLink(meta,realpathSync(path),resolve(path))||!e.stat||meta.dev!==e.stat.dev||meta.ino!==e.stat.ino||meta.size!==e.stat.size||meta.mtimeMs!==e.stat.mtimeMs||meta.ctimeMs!==e.stat.ctimeMs)throw new AssetsStoreError('FILE_UNAVAILABLE','扫描后源文件已变化，请仅重试失败项。')
    const base=assertAssetName(basename(path))
    const asset=await importFile(ctx,1,{expectedRevision:1,expectedCurrentVersionId:null},path,'文件夹导入',(s,now)=>{
      if(!selectCategory(s,q.options.category as string))throw new AssetsStoreError('BAD_CATEGORY','分类已改变，请重新扫描。')
      let name=base,n=2
      while(s.get('SELECT id FROM asset WHERE name=?',name)){const suffix=` (${n++})`;name=base.slice(0,200-suffix.length)+suffix}
      s.run("INSERT INTO asset(code,name,category,storage_type,source_json,created_at,updated_at) VALUES (?,?,?,'file',?,?,?)",`asset-${randomUUID()}`,name,q.options.category,JSON.stringify({folderImport:true,relativePath:e.dto.name}),now,now)
      const id=s.get<{id:number}>('SELECT last_insert_rowid() id')!.id
      replaceTags(s,id,q.options.tagNames??[])
      return id
    },meta)
    e.dto.state='done';e.dto.assetId=asset.id
  }catch(error){e.dto.state='failed';e.dto.error=error instanceof AssetsStoreError?error.message:'导入失败，请重试；详细原因见运行日志。'}
  finally{q.busy=false}
  return result(id,q)
}
export function cancelFolder(ctx:AssetsContext,input:unknown):{canceled:true}{const [id]=get(ctx,input);queues.delete(id);return {canceled:true}}
