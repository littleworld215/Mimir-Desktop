import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import type {AssetCategory,AssetListQuery,AssetTag,SavedAssetFilter,WorkspaceRequest} from '../../../../shared/assetsContracts'
import {assetsApi} from './assetsApi'
import {AssetError,AssetField,AssetModal,controlClass,errorMessage,useAssetsEditorGuard} from './assetsUi'
import {missingFilterConditions} from './assetTake'

export function SavedFilters({scope,query,tags,categories,write,onApply,onClose}:{scope:WorkspaceRequest;query:AssetListQuery;tags:AssetTag[];categories:AssetCategory[];write:<T>(fn:(s:WorkspaceRequest)=>Promise<T>)=>Promise<T>;onApply:(q:AssetListQuery)=>Promise<void>;onClose:()=>void}) {
  const [filters,setFilters]=useState<SavedAssetFilter[]>([]),[selected,setSelected]=useState<SavedAssetFilter|null>(null),[name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false)
  const [reload,setReload]=useState(0)
  const alive=useRef(true),saving=useRef(false)
  useEffect(()=>{alive.current=true;let active=true;setError('');void assetsApi.listSavedFilters(scope).then(r=>{if(active){setFilters(r.filters);setLoaded(true)}}).catch(e=>{if(active)setError(errorMessage(e))});return()=>{active=false;alive.current=false}},[scope.workspaceId,scope.spaceEpoch,reload])
  useAssetsEditorGuard({isDirty:()=>name!==(selected?.name??''),isBusy:()=>saving.current,save:async()=>false,discard:onClose})
  async function change(action:'create'|'replace'|'rename'|'delete') {
    if(saving.current)return
    saving.current=true;setBusy(true);setError('')
    try {
      await write(async s=>{
        if(action==='create')await assetsApi.createSavedFilter({...s,name,query})
        else if(selected){
          const condition={...s,filterId:selected.id,expectedRevision:selected.revision}
          if(action==='delete')await assetsApi.deleteSavedFilter(condition)
          else await assetsApi.updateSavedFilter({...condition,name,query:action==='rename'?selected.query:query})
        }
        const result=await assetsApi.listSavedFilters(s)
        if(alive.current){setFilters(result.filters);setSelected(null);setName('')}
      })
    }catch(e){if(alive.current)setError(errorMessage(e))}finally{saving.current=false;if(alive.current)setBusy(false)}
  }
  return <AssetModal title="保存筛选" onClose={()=>{if(!saving.current)onClose()}}><div className="space-y-3">
    <p className="text-sm text-muted-foreground">保存完整筛选条件，不保存页码或批量选择。失效分类和标签须显式修订后才能应用。</p>
    <AssetError message={error}/>{!loaded&&!error&&<p role="status">正在读取保存筛选…</p>}
    <Button variant="outline" size="sm" disabled={busy} onClick={()=>setReload(n=>n+1)}>重新加载筛选</Button>
    <Button variant="outline" size="sm" disabled={busy} onClick={()=>{setSelected(null);setName('')}}>新建筛选</Button>
    <AssetField label="筛选名称"><input className={controlClass} maxLength={80} value={name} disabled={busy} onChange={e=>setName(e.target.value)}/></AssetField>
    <div className="flex flex-wrap gap-2"><Button disabled={busy||!loaded||!name.trim()} onClick={()=>void change(selected?'rename':'create')}>{selected?'保存名称':'保存当前条件'}</Button>{selected&&<><Button variant="outline" disabled={busy||!name.trim()} onClick={()=>void change('replace')}>用当前条件替换</Button><Button variant="destructive" disabled={busy} onClick={()=>void change('delete')}>删除筛选</Button></>}</div>
    <ul className="space-y-2">{filters.map(f=>{const missing=missingFilterConditions(f.query,tags,categories);return <li key={f.id} className="rounded border border-border p-3"><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={()=>{setSelected(f);setName(f.name)}}>{f.name}</Button><Button size="sm" disabled={busy||!!missing.length} onClick={()=>void onApply(f.query)}>应用 {f.name}</Button></div>{missing.length>0&&<p className="text-sm text-destructive">失效条件：{missing.join('、')}。选择此筛选，再用当前条件替换。</p>}<pre className="mt-2 whitespace-pre-wrap break-all text-xs text-muted-foreground">{JSON.stringify(f.query,null,2)}</pre></li>})}</ul>
    <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
  </div></AssetModal>
}
