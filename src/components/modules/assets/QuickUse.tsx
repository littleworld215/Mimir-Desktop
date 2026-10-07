import {lazy,Suspense,useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import type {AssetDetail,AssetListQuery,AssetPage,AssetSummary,WorkspaceRequest} from '../../../../shared/assetsContracts'
import {assetsApi} from './assetsApi'
import {AssetError,AssetModal,controlClass,errorMessage,useAssetsEditorGuard} from './assetsUi'
import {readPins,takeAndRecord} from './assetTake'

const TemplateFill=lazy(()=>import('./TemplateFill').then(m=>({default:m.TemplateFill})))
export function QuickUse({scope,write,onChanged,onClose}:{scope:WorkspaceRequest;write:<T>(fn:(s:WorkspaceRequest)=>Promise<T>)=>Promise<T>;onChanged:()=>void;onClose:()=>void}) {
  const [draft,setDraft]=useState(''),[composing,setComposing]=useState(false),[query,setQuery]=useState<AssetListQuery>({view:'favorites',page:1,pageSize:20}),[page,setPage]=useState<AssetPage>({items:[],total:0,page:1,pageSize:20}),[asset,setAsset]=useState<AssetDetail|null>(null),[cursor,setCursor]=useState(0),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0)
  const [filling,setFilling]=useState(false)
  const pinKey=`mimir:asset-pins:${scope.workspaceId}`
  const [pins,setPins]=useState<number[]>(()=>{try{return readPins(localStorage.getItem(pinKey))}catch{return []}}),[pinned,setPinned]=useState<AssetSummary[]>([])
  const alive=useRef(false),listSeq=useRef(0),detailSeq=useRef(0),saving=useRef(false)
  const searchInput=useRef<HTMLInputElement>(null)
  function back(){++detailSeq.current;setAsset(null);searchInput.current?.focus()}
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;++listSeq.current;++detailSeq.current}},[])
  useAssetsEditorGuard({isDirty:()=>false,isBusy:()=>saving.current,save:async()=>false,discard:onClose})
  useEffect(()=>{if(composing)return;const timer=setTimeout(()=>setQuery(q=>draft.trim()===(q.q??'')?q:({...q,q:draft.trim()||undefined,page:1})),300);return()=>clearTimeout(timer)},[draft,composing])
  useEffect(()=>{
    const seq=++listSeq.current;++detailSeq.current;setAsset(null);setLoading(true);setError('')
    void assetsApi.list({...scope,...query}).then(r=>{if(alive.current&&seq===listSeq.current){setPage(r.page);setCursor(0)}}).catch(e=>{if(alive.current&&seq===listSeq.current)setError(errorMessage(e))}).finally(()=>{if(alive.current&&seq===listSeq.current)setLoading(false)})
  },[scope.workspaceId,scope.spaceEpoch,query,retry])
  useEffect(()=>{let active=true;if(!pins.length){setPinned([]);return}void assetsApi.list({...scope,ids:pins,pageSize:20}).then(r=>{if(active)setPinned(pins.flatMap(id=>r.page.items.filter(a=>a.id===id)))}).catch(()=>{if(active)setPinned([])});return()=>{active=false}},[pins,scope.workspaceId,scope.spaceEpoch])
  async function select(id:number){const seq=++detailSeq.current;setAsset(null);setError('');try{const r=await assetsApi.get({...scope,assetId:id});if(alive.current&&seq===detailSeq.current)setAsset(r.asset)}catch(e){if(alive.current&&seq===detailSeq.current)setError(errorMessage(e))}}
  function pin(){if(!asset)return;const next=pins.includes(asset.id)?pins.filter(id=>id!==asset.id):[asset.id,...pins].slice(0,20);try{localStorage.setItem(pinKey,JSON.stringify(next));setPins(next)}catch{setError('无法保存本机置顶，请检查浏览器存储。')}}
  async function take(close:boolean){
    if(!asset||saving.current||asset.archivedAt)return
    saving.current=true;setBusy(true);setError('');const selected=asset
    try {
      const notice=await write(s=>takeAndRecord(async()=>{
        if(selected.storageType==='file'){
          const destination=await window.electronAPI!.showSaveDialog({title:'快速取用文件（选择新路径）',defaultPath:selected.currentFileName??selected.name}) as {canceled:boolean;filePath?:string}
          if(destination.canceled||!destination.filePath)return false
          await assetsApi.saveFile({...s,assetId:selected.id,destinationPath:destination.filePath})
        }else await navigator.clipboard.writeText(selected.storageType==='external_link'?selected.externalUrl??'':selected.currentContent)
        return true
      },()=>assetsApi.recordUsage({...s,assetIds:[selected.id]})))
      if(alive.current&&notice){setNotice(notice);onChanged();if(close&&!notice.includes('未保存'))onClose()}
    }catch(e){if(alive.current)setError(errorMessage(e))}finally{saving.current=false;if(alive.current)setBusy(false)}
  }
  function keys(e:React.KeyboardEvent){
    if(composing||e.nativeEvent.isComposing||e.keyCode===229||busy)return
    if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&asset){e.preventDefault();void take(false);return}
    if((e.key==='ArrowDown'||e.key==='ArrowUp')&&!asset&&!loading){e.preventDefault();setCursor(i=>Math.max(0,Math.min(page.items.length-1,i+(e.key==='ArrowDown'?1:-1))))}
    if(e.key==='Enter'&&!asset&&!loading&&page.items[cursor]&&(e.target instanceof HTMLInputElement)){e.preventDefault();void select(page.items[cursor].id)}
  }
  return <><AssetModal title="快速取用" onClose={()=>{if(!saving.current&&!filling)onClose()}} onEscape={()=>{if(saving.current||composing||filling)return true;if(asset){back();return true}return false}}><div className="space-y-3" onKeyDown={keys}>
    <p className="text-xs text-muted-foreground">方向键选择，Enter 打开，Ctrl/Cmd+Enter 取用，Esc 返回。置顶仅保存在本机，最多20项，不随空间同步。</p>
    <input ref={searchInput} autoFocus className={controlClass} aria-label="快速检索" placeholder="检索资产…" maxLength={200} disabled={busy} value={draft} onChange={e=>setDraft(e.target.value)} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)}/>
    <div className="flex flex-wrap gap-2">{(['favorites','recent','all'] as const).map((view,i)=><Button key={view} size="sm" variant={query.view===view?'default':'outline'} disabled={busy} onClick={()=>setQuery(q=>({...q,view,page:1}))}>{['收藏','最近使用','全部'][i]}</Button>)}</div>
    <AssetError message={error}/>{error&&<Button variant="outline" disabled={busy} onClick={()=>setRetry(n=>n+1)}>重试</Button>}{notice&&<p role="status">{notice}</p>}
    {pinned.length>0&&<section aria-label="本机置顶" className="flex flex-wrap gap-2">{pinned.map(a=><Button key={a.id} size="sm" variant="outline" disabled={busy} onClick={()=>void select(a.id)}>置顶：{a.name}</Button>)}</section>}
    {loading?<p role="status">正在读取资产摘要…</p>:asset?<section aria-label="快速取用详情" className="space-y-3"><h3 className="font-medium">{asset.name}</h3><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-sm">{asset.storageType==='inline_text'?asset.currentContent:asset.externalUrl??asset.currentFileName}</pre><div className="flex flex-wrap gap-2"><Button disabled={busy||!!asset.archivedAt||(asset.storageType==='file'&&!asset.fileAvailable)} onClick={()=>void take(false)}>{asset.storageType==='file'?'下载':'复制'}</Button><Button variant="outline" disabled={busy||!!asset.archivedAt||(asset.storageType==='file'&&!asset.fileAvailable)} onClick={()=>void take(true)}>{asset.storageType==='file'?'下载并关闭':'复制并关闭'}</Button>{asset.storageType==='inline_text'&&<Button variant="outline" disabled={busy||!!asset.archivedAt} onClick={()=>setFilling(true)}>填值复制</Button>}<Button variant="outline" disabled={busy} onClick={pin}>{pins.includes(asset.id)?'取消置顶':'置顶'}</Button><Button variant="outline" disabled={busy} onClick={back}>返回结果</Button></div></section>:<section aria-label="快速取用结果" className="space-y-2">{page.items.map((a,i)=><Button key={a.id} variant="outline" className="w-full justify-start" aria-pressed={cursor===i} disabled={busy} onClick={()=>void select(a.id)}>{a.name} · {a.storageType}</Button>)}{!page.items.length&&<p>当前范围没有资产。</p>}<div className="flex justify-between"><Button variant="outline" disabled={busy||page.page<=1} onClick={()=>setQuery(q=>({...q,page:page.page-1}))}>上一页</Button><span>{page.page} / {Math.max(1,Math.ceil(page.total/page.pageSize))}</span><Button variant="outline" disabled={busy||page.page*page.pageSize>=page.total} onClick={()=>setQuery(q=>({...q,page:page.page+1}))}>下一页</Button></div></section>}
    <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
  </div></AssetModal>{filling&&asset&&<Suspense fallback={<p role="status">正在加载填值…</p>}><TemplateFill template={asset.currentContent} config={asset.templateConfig} onRecord={async()=>{await write(s=>assetsApi.recordUsage({...s,assetIds:[asset.id]}));onChanged()}} onClose={()=>setFilling(false)}/></Suspense>}</>
}
