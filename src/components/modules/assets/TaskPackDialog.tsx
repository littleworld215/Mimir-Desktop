import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import type {AssetDetail,ExchangeDocument,WorkspaceRequest} from '../../../../shared/assetsContracts'
import {buildTaskPack,copyTaskPack,normalizeTaskPackTemplate,taskPackSectionKey} from '@/lib/assets/bundleTemplate'
import {assetsApi} from './assetsApi'
import {AssetError,AssetField,AssetModal,controlClass,errorMessage,useAssetsEditorGuard} from './assetsUi'

export function TaskPackDialog({scope,ids,write,onChanged,onClose}:{scope:WorkspaceRequest;ids:number[];write:<T>(fn:(s:WorkspaceRequest)=>Promise<T>)=>Promise<T>;onChanged:()=>void;onClose:()=>void}) {
  const [items,setItems]=useState<AssetDetail[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  const [template,setTemplate]=useState(()=>normalizeTaskPackTemplate(null)),[dirty,setDirty]=useState(false),[prefsLoading,setPrefsLoading]=useState(true),[retry,setRetry]=useState(0)
  const [originalOnly,setOriginalOnly]=useState(false),[original,setOriginal]=useState<{key:string;map:Map<string,string>}|null>(null),[originalError,setOriginalError]=useState('')
  const working=useRef(false),composing=useRef(false),alive=useRef(true),preferenceEdited=useRef(false)
  const preferenceKey=`assets-task-pack:${scope.workspaceId}`,selectionKey=ids.join(',')
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{let active=true;setLoading(true);setError('')
    void (async()=>{const result:AssetDetail[]=[];for(const id of new Set(ids)){if(!active)return;result.push((await assetsApi.get({...scope,assetId:id})).asset)}if(active)setItems(result)})().catch(e=>{if(active)setError(`${errorMessage(e)}；未生成部分任务包，请重试或关闭后重新选择。`)}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[scope.workspaceId,scope.spaceEpoch,selectionKey,retry])
  useEffect(()=>{let active=true
    void window.electronAPI!.getStoreValue(preferenceKey).then(value=>{if(active&&!preferenceEdited.current)setTemplate(normalizeTaskPackTemplate(value))}).catch(e=>{if(active)setNotice(`设置读取失败，使用默认模板：${errorMessage(e)}`)}).finally(()=>{if(active)setPrefsLoading(false)})
    return()=>{active=false}
  },[preferenceKey])
  const itemKey=items.map(a=>`${a.id}:${a.revision}:${a.currentVersionId}`).join(',')
  useEffect(()=>{let active=true;setOriginal(null);setOriginalError('')
    if(originalOnly&&!loading&&!error&&items.length)void assetsApi.exportAssets({...scope,ids:items.map(a=>a.id),format:'json',ai:'original-only'}).then(result=>{
      const document=JSON.parse(result.result.content) as ExchangeDocument,map=new Map<string,string>()
      for(const asset of document.assets)if(asset.storageType==='inline_text'&&typeof asset.content==='string')map.set(asset.code,asset.content)
      if(active)setOriginal({key:itemKey,map})
    }).catch(e=>{if(active)setOriginalError(errorMessage(e))})
    return()=>{active=false}
  },[originalOnly,itemKey,scope.workspaceId,scope.spaceEpoch,loading,error,retry])
  let pack:ReturnType<typeof buildTaskPack>|null=null,previewError=''
  try{if(!loading&&!error&&(!originalOnly||original?.key===itemKey))pack=buildTaskPack(items.map(a=>({...a,...(original?.key===itemKey&&original.map.has(a.code)?{originalContent:original.map.get(a.code)}:{})})),{template,ai:originalOnly?'original-only':'include'})}catch(e){previewError=errorMessage(e)}
  function changeTemplate(next:typeof template){preferenceEdited.current=true;setDirty(true);setTemplate(next)}
  async function savePreferences():Promise<boolean>{
    if(working.current)return false;working.current=true;setBusy(true);setError('')
    try{await write(async()=>window.electronAPI!.setStoreValue(preferenceKey,normalizeTaskPackTemplate(template)));if(alive.current){setDirty(false);setNotice('本机任务包模板已保存。')}return true}catch(e){if(alive.current)setNotice(`设置未保存：${errorMessage(e)}；输入已保留。`);return false}finally{working.current=false;if(alive.current)setBusy(false)}
  }
  useAssetsEditorGuard({isDirty:()=>false,isBusy:()=>working.current,save:savePreferences,discard:onClose})
  async function copy(){
    if(working.current||composing.current||!pack?.assetIds.length)return
    const snapshot=pack;working.current=true;setBusy(true);setNotice('')
    try{const result=await write(s=>copyTaskPack(snapshot,text=>navigator.clipboard.writeText(text),assetIds=>assetsApi.recordUsage({...s,assetIds})));if(alive.current){setNotice(result);onChanged()}}catch(e){if(alive.current)setNotice(`复制失败：${errorMessage(e)}；选择与预览已保留。`)}finally{working.current=false;if(alive.current)setBusy(false)}
  }
  function move(index:number,delta:number){setItems(old=>{const next=[...old],key=taskPackSectionKey(next[index].kind);let destination=index+delta;while(destination>=0&&destination<next.length&&taskPackSectionKey(next[destination].kind)!==key)destination+=delta;if(destination>=0&&destination<next.length)[next[index],next[destination]]=[next[destination],next[index]];return next})}
  return <AssetModal title="任务包组合复制" onClose={()=>{if(!working.current&&!composing.current)onClose()}} onEscape={()=>working.current||composing.current}>
    <div className="space-y-3" onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing&&e.keyCode!==229&&!composing.current){e.preventDefault();void copy()}}}>
      <p className="text-xs text-muted-foreground">最多500项。文件本体另行下载附上；模板设置按科研空间保存在本机，不承诺外部同步。</p>
      {loading&&<p role="status">正在读取所选资产正文…</p>}<AssetError message={error||originalError||previewError}/>{(error||originalError)&&<Button disabled={busy} variant="outline" onClick={()=>setRetry(n=>n+1)}>重试读取</Button>}
      <fieldset disabled={busy||loading} className="space-y-2"><label className="text-sm"><input type="checkbox" checked={originalOnly} onChange={e=>{setOriginal(null);setOriginalOnly(e.target.checked)}}/> 仅原文（排除 AI 资产，取非 AI 版本）</label>
        {items.map((a,i)=><div key={a.id} className="flex flex-wrap items-center gap-2 text-sm"><span className="min-w-0 break-words">{a.name}</span><Button size="sm" variant="outline" onClick={()=>move(i,-1)}>上移</Button><Button size="sm" variant="outline" onClick={()=>move(i,1)}>下移</Button><Button size="sm" variant="outline" onClick={()=>setItems(old=>old.filter(item=>item.id!==a.id))}>移出任务包</Button></div>)}
      </fieldset>
      {originalOnly&&!original&&!originalError&&!loading&&items.length>0&&<p role="status">正在读取原文版本…</p>}
      <details><summary className="cursor-pointer text-sm">任务包模板设置</summary><fieldset disabled={busy||prefsLoading} className="mt-3 space-y-3">
        {(['includeHeader','includeSource','includeNotes','includeTags'] as const).map((key,i)=><label key={key} className="mr-3 inline-flex gap-2 text-sm"><input type="checkbox" checked={template[key]} onChange={e=>changeTemplate({...template,[key]:e.target.checked})}/>{['总标题','来源','备注','标签'][i]}</label>)}
        {template.sections.map((section,i)=><div key={section.key} className="flex items-end gap-2"><AssetField label={`${section.key} 节标题`}><input className={controlClass} maxLength={200} value={section.title} onChange={e=>changeTemplate({...template,sections:template.sections.map((s,j)=>j===i?{...s,title:e.target.value}:s)})}/></AssetField><Button size="sm" variant="outline" disabled={i===0} onClick={()=>{const sections=[...template.sections];[sections[i-1],sections[i]]=[sections[i],sections[i-1]];changeTemplate({...template,sections})}}>前移</Button></div>)}
        <Button variant="outline" disabled={!dirty} onClick={()=>void savePreferences()}>保存模板设置</Button><p className="text-xs">{prefsLoading?'正在读取设置…':dirty?'设置未保存，关闭后不保留本次设置。':'设置已载入。'}</p>
      </fieldset></details>
      <p className="text-xs">实际纳入 {pack?.assetIds.length??0} 项 · 排除 {pack?.excludedIds.length??0} 项</p><pre aria-label="任务包预览" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-3 text-sm">{pack?.text??''}</pre>
      {notice&&<p role="status" className="text-sm">{notice}</p>}<div className="flex gap-2"><Button disabled={busy||!pack?.assetIds.length} onClick={()=>void copy()}>复制任务包</Button><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></div>
    </div>
  </AssetModal>
}
