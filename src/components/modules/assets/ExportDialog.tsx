import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetListQuery, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
export function ExportDialog({query,ids,write,onClose}:{query:AssetListQuery;ids:number[];write:<T>(fn:(s:WorkspaceRequest)=>Promise<T>)=>Promise<T>;onClose:()=>void}) {
  const [format,setFormat]=useState<'json'|'markdown'>('json'),[ai,setAi]=useState<'include'|'original-only'>('include'),[selected,setSelected]=useState(ids.length>0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const saving=useRef(false)
  useAssetsEditorGuard({isDirty:()=>false,isBusy:()=>saving.current,save:async()=>false,discard:onClose})
  async function save(){
    if(saving.current)return
    saving.current=true;setBusy(true);setError('');setNotice('')
    try{const result=await write(async scope=>{const path=await window.electronAPI!.showSaveDialog({title:'保存导出（请选择新路径）',defaultPath:`资产导出.${format==='json'?'json':'md'}`}) as {canceled:boolean;filePath?:string};if(path.canceled||!path.filePath)return null;const {page:_page,pageSize:_size,ids:_ids,...filters}=query;return assetsApi.saveExchange({...scope,query:filters,...(selected?{ids}:{}),format,ai,destinationPath:path.filePath})});if(result)setNotice(`已导出 ${result.count} 项。`)}catch(error){setError(errorMessage(error))}finally{saving.current=false;setBusy(false)}
  }
  return <AssetModal title="导出资产" onClose={()=>{if(!saving.current)onClose()}}><div className="space-y-3">
    <p className="text-sm text-muted-foreground">导出完整筛选结果，不限当前页；文件仅导出元信息。已有目标文件不会被覆盖。</p>
    <AssetField label="导出范围"><select className={controlClass} value={selected?'selected':'filtered'} disabled={busy} onChange={e=>setSelected(e.target.value==='selected')}><option value="filtered">全部当前筛选结果</option><option value="selected" disabled={!ids.length}>所选 {ids.length} 项（最多500）</option></select></AssetField>
    <AssetField label="格式"><select className={controlClass} value={format} disabled={busy} onChange={e=>setFormat(e.target.value as typeof format)}><option value="json">JSON（可重新导入）</option><option value="markdown">Markdown</option></select></AssetField>
    <AssetField label="AI产出"><select className={controlClass} value={ai} disabled={busy} onChange={e=>setAi(e.target.value as typeof ai)}><option value="include">含AI产出</option><option value="original-only">仅原文</option></select></AssetField>
    <AssetError message={error}/>{notice&&<p role="status">{notice}</p>}<div className="flex justify-end gap-2"><Button disabled={busy} variant="outline" onClick={onClose}>关闭</Button><Button disabled={busy||(selected&&(!ids.length||ids.length>500))} onClick={()=>void save()}>保存导出</Button></div>
  </div></AssetModal>
}
