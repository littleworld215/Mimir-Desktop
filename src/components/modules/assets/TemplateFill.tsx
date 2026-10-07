import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {initialTemplateValues,renderConfiguredTemplate,parseVariables} from '@/lib/assets/template'
import {AssetError,AssetModal,errorMessage,useAssetsEditorGuard} from './assetsUi'
import {TemplateFields} from './TemplateFields'
import {takeAndRecord} from './assetTake'

export function TemplateFill({template,config,onRecord,onClose}:{template:string;config?:unknown;onRecord:()=>Promise<unknown>;onClose:()=>void}) {
  const [values,setValues]=useState(()=>initialTemplateValues(template,config)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const working=useRef(false),composing=useRef(false),alive=useRef(true)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useAssetsEditorGuard({isDirty:()=>false,isBusy:()=>working.current,save:async()=>false,discard:onClose})
  let preview='',previewError=''
  try{preview=renderConfiguredTemplate(template,values,config)}catch(e){previewError=errorMessage(e)}
  async function copy(close=false) {
    if(working.current||previewError||composing.current)return
    working.current=true;setBusy(true);setError('');setNotice('')
    try {
      const result=await takeAndRecord(async()=>{await navigator.clipboard.writeText(preview);return true},onRecord)
      if(alive.current){setNotice(result??'');if(close&&result==='取用成功。')onClose()}
    }catch(e){if(alive.current)setError(errorMessage(e))}
    finally{working.current=false;if(alive.current)setBusy(false)}
  }
  return <AssetModal title="填值复制" onClose={()=>{if(!working.current&&!composing.current)onClose()}} onEscape={()=>working.current||composing.current}>
    <div className="space-y-4" onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing&&e.keyCode!==229&&!composing.current){e.preventDefault();void copy()}}}>
      <p className="text-xs text-muted-foreground">填写后检查预览。Ctrl/Cmd+Enter 复制；多行输入的 Enter 换行。</p>
      <TemplateFields template={template} config={config} values={values} onChange={setValues} disabled={busy}/>
      {parseVariables(template).invalid>0&&<p className="text-sm">{parseVariables(template).invalid} 个格式警告，非法占位符按原文保留。</p>}
      <pre aria-label="填值预览" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-3 text-sm">{preview}</pre>
      <AssetError message={error||previewError}/>{notice&&<p role="status">{notice}</p>}
      <div className="flex flex-wrap gap-2"><Button disabled={busy||Boolean(previewError)} onClick={()=>void copy()}>复制</Button><Button variant="outline" disabled={busy||Boolean(previewError)} onClick={()=>void copy(true)}>复制并关闭</Button><Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></div>
    </div>
  </AssetModal>
}
