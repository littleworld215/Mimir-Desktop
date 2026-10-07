import type {TemplateValues} from '@/lib/assets/template'
import {variableControls} from '@/lib/assets/template'
import {AssetField,controlClass} from './assetsUi'

export function TemplateFields({template,config,values,onChange,disabled=false,excludeNames=[]}:{template:string;config?:unknown;values:TemplateValues;onChange:(values:TemplateValues)=>void;disabled?:boolean;excludeNames?:readonly string[]}) {
  return <fieldset disabled={disabled} className="space-y-3">{variableControls(template,config).filter(v=>!excludeNames.includes(v.name)).map(v=>{
    const value=values[v.name]??'', update=(next:string|string[])=>onChange({...values,[v.name]:next})
    if(v.type==='multi') {
      const selected=Array.isArray(value)?value:[],options=[...new Set([...v.options,...selected])]
      return <fieldset key={v.name} className="rounded border p-3"><legend className="text-sm">{v.name}</legend>{options.map(option=><label key={option} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(option)} onChange={e=>update(e.target.checked?[...selected,option]:selected.filter(s=>s!==option))}/>{option}</label>)}</fieldset>
    }
    const text=typeof value==='string'?value:''
    return <AssetField key={v.name} label={v.name}>{v.type==='textarea'?<textarea className={`${controlClass} min-h-28`} value={text} onChange={e=>update(e.target.value)}/>:v.type==='single'?<select className={controlClass} value={text} onChange={e=>update(e.target.value)}>{[...new Set(['',...v.options,text])].map(o=><option key={o} value={o}>{o||'（空值）'}</option>)}</select>:<input className={controlClass} value={text} onChange={e=>update(e.target.value)}/>}</AssetField>
  })}</fieldset>
}
