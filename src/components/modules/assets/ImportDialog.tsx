import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { requestAssetsLeave } from '@/lib/assetsEditGuard'
import { ASSET_TRANSFER_MAX_BYTES, type AssetImportMode, type AssetImportPreview, type AssetPromptAdaptation, type WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
import { useAssetPreview } from './useAssetPreview'

export function ImportDialog({scope,write,onChanged,onClose}:{scope:WorkspaceRequest;write:<T>(fn:(s:WorkspaceRequest)=>Promise<T>)=>Promise<T>;onChanged:()=>void;onClose:()=>void}) {
  const [raw,setRaw]=useState(''),[mode,setMode]=useState<AssetImportMode>('skip'),[skips,setSkips]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [format,setFormat]=useState('native'),[convertVariables,setConvertVariables]=useState(false)
  const saving=useRef(false),generation=useRef(0),preview=useAssetPreview<AssetImportPreview & {acceptedRaw:string;adaptation?:AssetPromptAdaptation}>()
  useEffect(()=>()=>{++generation.current},[])
  function changeRaw(value:string){++generation.current;setRaw(value);preview.clear();setError('')}
  const request=()=>({...scope,raw,mode,skipIndexes:skips.trim()===''?[]:skips.split(/[,，\s]+/).filter(Boolean).map(Number)})
  async function commit():Promise<boolean>{
    if(saving.current||!preview.value?.canCommit)return false
    saving.current=true;setBusy(true);setError('')
    try{const result=await write(s=>assetsApi.importJson({...request(),...s,raw:preview.value!.acceptedRaw,previewToken:preview.value!.previewToken}));setRaw('');preview.clear();onChanged();onClose();return result.result.created+result.result.updated+result.result.skipped>=0}
    catch(error){setError(`${errorMessage(error)}\n输入已保留，请重新预览后重试。`);preview.clear();return false}
    finally{saving.current=false;setBusy(false)}
  }
  useAssetsEditorGuard({isDirty:()=>raw!=='',isBusy:()=>saving.current,save:commit,discard:onClose})
  async function selectFile(){
    if(saving.current)return
    const ticket=++generation.current
    saving.current=true;setBusy(true);setError('')
    try{const result=await write(async s=>{const chosen=await window.electronAPI!.showOpenDialog({title:'导入JSON',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]}) as {canceled:boolean;filePaths:string[]};if(chosen.canceled||!chosen.filePaths[0])return null;return assetsApi.readExchangeFile({...s,sourcePath:chosen.filePaths[0]})});if(result&&ticket===generation.current)changeRaw(result.raw)}
    catch(error){if(ticket===generation.current)setError(errorMessage(error))}finally{saving.current=false;setBusy(false)}
  }
  async function drop(file:File|undefined){
    if(!file||saving.current)return
    preview.clear()
    if(file.size>ASSET_TRANSFER_MAX_BYTES){setError('JSON超过200MiB。');return}
    const ticket=++generation.current
    saving.current=true;setBusy(true);setError('')
    try{const value=await file.text();if(ticket===generation.current)changeRaw(value)}catch(error){if(ticket===generation.current)setError(errorMessage(error))}finally{saving.current=false;if(ticket===generation.current||ticket+1===generation.current)setBusy(false)}
  }
  return <AssetModal title="导入JSON" onClose={()=>{++generation.current;if(!saving.current)void requestAssetsLeave().then(ok=>{if(ok)onClose()})}}>
    <div className="space-y-3" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void drop(e.dataTransfer.files[0])}}>
      <p className="text-sm text-muted-foreground">选择或拖入JSON，也可粘贴内容。先预览差异，再确认导入；文件字节需另行导入。</p>
      <Button variant="outline" disabled={busy} onClick={()=>void selectFile()}>选择JSON文件</Button>
      <AssetField label="来源格式"><select className={controlClass} disabled={busy} value={format} onChange={e=>{setFormat(e.target.value);preview.clear()}}><option value="native">本项目 JSON</option><option value="prompt">PromptDock／PromptDeck</option></select></AssetField>
      {format==='prompt'&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={convertVariables} onChange={e=>{setConvertVariables(e.target.checked);preview.clear()}}/>显式转换变量语法（默认保留原文）</label>}
      <AssetField label="JSON内容"><textarea className={`${controlClass} min-h-40 font-mono`} disabled={busy} value={raw} onChange={e=>changeRaw(e.target.value)} /></AssetField>
      <AssetField label="冲突策略"><select className={controlClass} disabled={busy} value={mode} onChange={e=>{setMode(e.target.value as AssetImportMode);preview.clear()}}><option value="skip">跳过已有</option><option value="overwrite">覆盖同形态元信息／正文</option><option value="copy">创建副本</option></select></AssetField>
      <AssetField label="跳过行号（逗号分隔，1开始）"><input className={controlClass} disabled={busy} value={skips} onChange={e=>{setSkips(e.target.value);preview.clear()}} /></AssetField>
      <Button variant="outline" disabled={busy||!raw||preview.loading} onClick={()=>void preview.read(async()=>{const adaptation=format==='prompt'?(await assetsApi.adaptPromptImport({...scope,raw,convertVariables})).adaptation:undefined;const acceptedRaw=adaptation?.raw??raw;return {...(await assetsApi.previewImport({...request(),raw:acceptedRaw})).preview,acceptedRaw,adaptation}})}>预览差异</Button>
      <AssetError message={error||preview.error} />
      {preview.loading&&<p role="status">正在读取只读预览…</p>}
      {preview.value&&<section aria-label="导入差异" className="space-y-2 text-sm"><p>新增 {preview.value.created} · 更新 {preview.value.updated} · 跳过 {preview.value.skipped} · 文件空壳 {preview.value.filesMissing}</p>
        {preview.value.adaptation&&<section aria-label="格式转换差异"><p>{preview.value.adaptation.warnings.join('；')}</p>{preview.value.adaptation.changes.map((c,i)=><details key={i}><summary>{c.name} · 变量转换前后</summary><p>{c.warnings.join('；')}</p><div className="grid gap-2 sm:grid-cols-2"><pre className="whitespace-pre-wrap break-all">{c.before}</pre><pre className="whitespace-pre-wrap break-all">{c.after}</pre></div></details>)}</section>}
        {preview.value.errors.map(e=><p key={e.index} role="alert">第 {e.index} 行：{e.message}</p>)}
        {!!preview.value.categoriesMissing.length&&<p>将创建分类：{preview.value.categoriesMissing.join('；')}</p>}
        {!!preview.value.referencesMissing.length&&<p>将忽略缺失参见：{preview.value.referencesMissing.join('；')}</p>}
        {!!preview.value.duplicates.length&&<details><summary>重复内容／标识匹配</summary>{preview.value.duplicates.map(d=><p key={d.index}>第 {d.index} 行：{d.matches.join('、')}</p>)}</details>}
        {preview.value.rows.map(r=><details key={r.index}><summary>第 {r.index} 行 · {r.after?.name??r.code} · {r.action} · {r.targetCode}</summary><p>{r.warnings.join('；')}</p><div className="grid gap-2 sm:grid-cols-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">原内容：{JSON.stringify(r.before,null,2)}</pre><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">导入内容：{JSON.stringify(r.after,null,2)}</pre></div></details>)}
      </section>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={()=>void requestAssetsLeave().then(ok=>{if(ok)onClose()})}>取消</Button><Button disabled={busy||!preview.value?.canCommit} onClick={()=>void commit()}>{busy?'导入中…':'确认导入'}</Button></div>
    </div>
  </AssetModal>
}
