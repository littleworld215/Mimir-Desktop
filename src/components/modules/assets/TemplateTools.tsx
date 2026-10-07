import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {parseVariables,initialTemplateValues,renderConfiguredTemplate} from '@/lib/assets/template'
import type {TemplateValues} from '@/lib/assets/template'
import {readTemplateConfig} from '../../../../shared/templateConfig'
import type {TemplateConfigVariable} from '../../../../shared/assetsContracts'
import {AssetError,AssetField,controlClass,errorMessage} from './assetsUi'
import {TemplateFields} from './TemplateFields'

export function TemplateTools({content,configRaw,onContent,onConfig,bodyRef}:{content:string;configRaw:string;onContent:(s:string)=>void;onConfig:(s:string)=>void;bodyRef?:React.RefObject<HTMLTextAreaElement>}) {
  const [name,setName]=useState(''),[defaultValue,setDefault]=useState(''),[error,setError]=useState(''),[trial,setTrial]=useState<TemplateValues|null>(null)
  const parsed=parseVariables(content),config=readTemplateConfig(configRaw)
  let raw:Record<string,unknown>|null=null
  try {const value=JSON.parse(configRaw);if(value&&value.version===1&&value.variables&&typeof value.variables==='object'&&!Array.isArray(value.variables))raw=value}catch{ /* Keep malformed JSON editable in the advanced field. */ }
  function insert() {
    const token=`{{${name}${defaultValue?`:${defaultValue}`:''}}}`
    if(parseVariables(token).variables.length!==1||name!==name.trim()){setError('变量名称不能为空，最长64字，不能包含花括号或冒号。');return}
    const element=bodyRef?.current,start=element?.selectionStart??content.length,end=element?.selectionEnd??content.length
    onContent(content.slice(0,start)+token+content.slice(end));setError('');setTrial(null)
    if(element)requestAnimationFrame(()=>{element.focus();element.setSelectionRange(start+token.length,start+token.length)})
  }
  function update(variable:string,patch:Partial<TemplateConfigVariable>) {
    if(!raw||['__proto__','constructor','prototype'].includes(variable))return
    const variables={...raw.variables as Record<string,unknown>},previous=variables[variable]
    const next={type:'text',...(previous&&typeof previous==='object'?previous:{}),...patch} as TemplateConfigVariable
    if((next.type==='single'||next.type==='multi')&&!next.options?.length&&!Object.hasOwn(patch,'options'))next.options=['候选项']
    variables[variable]=next;onConfig(JSON.stringify({...raw,variables},null,2));setTrial(null)
  }
  let preview='',previewError=''
  try{if(trial)preview=renderConfiguredTemplate(content,trial,configRaw)}catch(e){previewError=errorMessage(e)}
  return <section aria-label="模板编写引导" className="space-y-3 rounded border border-border p-3">
    <h3 className="text-sm font-medium">模板编写引导</h3>
    <div className="grid gap-2 sm:grid-cols-2"><AssetField label="变量名称"><input className={controlClass} value={name} onChange={e=>setName(e.target.value)}/></AssetField><AssetField label="变量默认值"><input className={controlClass} value={defaultValue} onChange={e=>setDefault(e.target.value)}/></AssetField></div>
    <Button size="sm" type="button" variant="outline" onClick={insert}>插入变量</Button>
    <details><summary className="cursor-pointer text-sm">查看示例</summary><pre className="whitespace-pre-wrap text-xs">{'{{语言:中文}}\n{{原文}}\n旧模板继续支持 {{变量}} 与 {{变量:默认值}}；空值不替换成默认值。'}</pre></details>
    <p className="text-xs">已识别 {parsed.variables.length} 个变量 · {parsed.invalid} 个格式警告</p>
    {!raw&&<AssetError message="变量配置 JSON 无法解析，请在高级字段修复后再配置。"/>}
    {raw&&Object.keys(raw.variables as object).length!==Object.keys(config.variables).length&&<AssetError message="变量配置含非法字段或候选项，试填暂按旧文本规则；请修复后保存。"/>}
    {parsed.variables.map(v=>{
      const item=(raw?.variables as Record<string,TemplateConfigVariable>|undefined)?.[v.name],type=item?.type??config.variables[v.name]?.type??'text'
      return <div key={v.name} className="space-y-2 rounded border p-2"><p className="break-words text-xs">{v.name} · 默认值：{v.defaultValue||'（空）'}</p><AssetField label={`${v.name} 输入类型`}><select className={controlClass} value={type} disabled={!raw||['__proto__','constructor','prototype'].includes(v.name)} onChange={e=>update(v.name,{type:e.target.value as TemplateConfigVariable['type']})}><option value="text">文本</option><option value="textarea">多行</option><option value="single">单选</option><option value="multi">多选</option></select></AssetField>{(type==='single'||type==='multi')&&<AssetField label={`${v.name} 候选项（每行一个）`}><textarea className={controlClass} value={Array.isArray(item?.options)?item.options.join('\n'):''} onChange={e=>update(v.name,{options:e.target.value.split('\n')})}/></AssetField>}{type==='multi'&&<AssetField label={`${v.name} 连接符`}><input className={controlClass} value={typeof item?.separator==='string'?item.separator:'、'} onChange={e=>update(v.name,{separator:e.target.value})}/></AssetField>}</div>
    })}
    <Button type="button" size="sm" variant="outline" onClick={()=>setTrial(trial?null:initialTemplateValues(content,configRaw))}>{trial?'关闭试填':'试填预览'}</Button>
    {trial&&<><TemplateFields template={content} config={configRaw} values={trial} onChange={setTrial}/><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">{preview}</pre></>}
    <AssetError message={error||previewError}/><p className="text-xs text-muted-foreground">引导与试填不保存资产；请用表单保存。候选项需非空且不重复。</p>
  </section>
}
