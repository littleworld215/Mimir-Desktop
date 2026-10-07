import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { requestAssetsLeave } from '@/lib/assetsEditGuard'
import type { AssetCategory, AssetFolderQueue, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
export function BatchImportDialog({scope,categories,write,onChanged,onClose}:{scope:WorkspaceRequest;categories:AssetCategory[];write:<T>(fn:(s:WorkspaceRequest)=>Promise<T>)=>Promise<T>;onChanged:()=>void;onClose:()=>void}) {
  const [queue,setQueue]=useState<AssetFolderQueue|null>(null),[category,setCategory]=useState('inbox'),[tags,setTags]=useState(''),[running,setRunning]=useState(false),[paused,setPaused]=useState(false),[error,setError]=useState('')
  const inFlight=useRef(false),stop=useRef(true),current=useRef<AssetFolderQueue|null>(null),alive=useRef(true)
  async function release(q:AssetFolderQueue|null){if(q)try{await assetsApi.cancelFolder({...scope,queueId:q.queueId})}catch{/* 旧空间队列不可再写；当前文件结束后再清理。 */}}
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;stop.current=true;if(!inFlight.current){const q=current.current;current.current=null;void release(q)}}},[])
  async function dispose(){if(inFlight.current)return;const q=current.current;current.current=null;stop.current=true;if(q)try{await write(s=>assetsApi.cancelFolder({...s,queueId:q.queueId}))}catch{/* 旧队列在切空间后过期，不影响已提交文件。 */}onChanged();onClose()}
  useAssetsEditorGuard({isDirty:()=>Boolean(current.current?.entries.some(e=>e.state==='pending')),isBusy:()=>inFlight.current,save:async()=>false,discard:()=>{void dispose()}})
  async function scan(){if(inFlight.current)return;inFlight.current=true;setRunning(true);setError('');try{const found=await write(async s=>{const path=await window.electronAPI!.showOpenDialog({title:'选择批量导入文件夹',properties:['openDirectory']}) as {canceled:boolean;filePaths:string[]};if(path.canceled||!path.filePaths[0]||!alive.current)return null;return assetsApi.scanFolder({...s,folderPath:path.filePaths[0],category,tagNames:tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean)})});if(found){if(!alive.current){await release(found.queue);return}current.current=found.queue;setQueue(found.queue);setPaused(true)}}catch(error){if(alive.current)setError(errorMessage(error))}finally{inFlight.current=false;if(alive.current)setRunning(false)}}
  async function run(retryFailed=false){
    if(inFlight.current||!current.current)return
    stop.current=false;setPaused(false);setRunning(true);setError('')
    try{
      let retry=retryFailed
      while(!stop.current){
        inFlight.current=true
        const out=await write(s=>assetsApi.nextFolderFile({...s,queueId:current.current!.queueId,...(retry?{retryFailed:true}:{})}))
        retry=false;current.current=out.queue;inFlight.current=false
        if(!alive.current)break
        setQueue(out.queue)
        if(!out.queue.entries.some(e=>e.state==='pending'))break
      }
      if(alive.current)onChanged()
    }catch(error){if(alive.current)setError(`${errorMessage(error)}；队列状态已保留，成功文件不会重复导入。`)}finally{inFlight.current=false;stop.current=true;if(alive.current){setRunning(false);setPaused(Boolean(current.current?.entries.some(e=>e.state==='pending')))}else{const q=current.current;current.current=null;await release(q)}}
  }
  return <AssetModal title="文件夹批量导入" onClose={()=>{if(!inFlight.current)void requestAssetsLeave().then(ok=>{if(ok)void dispose()})}}><div className="space-y-3">
    <p className="text-sm text-muted-foreground">普通文件逐个导入，默认未分类，同名加序号；拒绝链接、junction与托管数据。暂停会等待当前文件完成，成功项不会重复导入。</p>
    <AssetField label="导入分类"><select className={controlClass} disabled={running||Boolean(queue)} value={category} onChange={e=>setCategory(e.target.value)}><option value="inbox">未分类</option>{categories.filter(c=>c.code!=='inbox').map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></AssetField>
    <AssetField label="批量添加标签（逗号分隔）"><input className={controlClass} value={tags} disabled={running||Boolean(queue)} onChange={e=>setTags(e.target.value)}/></AssetField>
    <Button variant="outline" disabled={running||Boolean(queue)} onClick={()=>void scan()}>选择文件夹并扫描</Button><AssetError message={error}/>
    {queue&&<section aria-label="文件导入队列" className="space-y-2"><p role="status">已处理 {queue.completed} / {queue.total} · {running?'处理中':paused?'已暂停':'已结束'} · 成功 {queue.entries.filter(e=>e.state==='done').length} · 失败 {queue.entries.filter(e=>e.state==='failed').length}</p><progress className="w-full" value={queue.completed} max={Math.max(queue.total,1)}/><div className="max-h-60 overflow-auto">{queue.entries.map(e=><p key={e.index} className="break-all text-sm">{e.name} · {e.state}{e.error?`：${e.error}`:''}</p>)}</div><div className="flex flex-wrap gap-2"><Button disabled={running||!queue.entries.some(e=>e.state==='pending')} onClick={()=>void run()}>开始／继续</Button><Button variant="outline" disabled={!running} onClick={()=>{stop.current=true;setPaused(true)}}>暂停</Button><Button variant="outline" disabled={running||queue.entries.some(e=>e.state==='pending')||!queue.entries.some(e=>e.state==='failed')} onClick={()=>void run(true)}>只重试失败项</Button></div></section>}
    <div className="flex justify-end"><Button variant="outline" disabled={running} onClick={()=>void requestAssetsLeave().then(ok=>{if(ok)void dispose()})}>取消队列并关闭</Button></div>
  </div></AssetModal>
}
