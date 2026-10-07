import type {TemplateVariable,TemplateValues,VariableInputType} from './assetsContracts'
import {readTemplateConfig} from './templateConfig'
import {textBuilder} from './assetsTextBudget'
export type {TemplateValues} from './assetsContracts'

export const ORIGINAL_VAR='原文'
export const INJECT_SEPARATOR='\n\n---\n\n'
const validName=(name:string)=>name.length>0&&name.length<=64&&!/[{}:]/.test(name)
function placeholder(inner:string) {
  const colon=inner.indexOf(':')
  return {name:(colon<0?inner:inner.slice(0,colon)).trim(),defaultValue:colon<0?'':inner.slice(colon+1)}
}
export function parseVariables(template:string):{variables:TemplateVariable[];invalid:number} {
  const variables:TemplateVariable[]=[],seen=new Set<string>()
  let invalid=0,matched=0
  for(const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    matched++
    const variable=placeholder(match[1])
    if(!validName(variable.name)){invalid++;continue}
    if(!seen.has(variable.name)){seen.add(variable.name);variables.push(variable)}
  }
  invalid+=Math.max(0,(template.match(/\{\{/g)||[]).length-matched)
  return {variables,invalid}
}
export function renderTemplate(template:string,values:Record<string,string>,maxBytes?:number):string {
  const result=textBuilder(maxBytes)
  let offset=0
  for(const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    result.append(template.slice(offset,match.index))
    const variable=placeholder(match[1])
    result.append(!validName(variable.name)?match[0]:Object.prototype.hasOwnProperty.call(values,variable.name)?values[variable.name]??'':variable.defaultValue)
    offset=match.index!+match[0].length
  }
  result.append(template.slice(offset))
  return result.finish()
}
/** Exact legacy AI injection rule: only literal {{原文}} replaces; otherwise append. */
export function buildFinalPrompt(template:string,values:Record<string,string>,original:string):string {
  if(template.includes('{{原文}}'))return renderTemplate(template,{...values,[ORIGINAL_VAR]:original})
  const result=textBuilder()
  result.append(renderTemplate(template,values));result.append(INJECT_SEPARATOR);result.append(original)
  return result.finish()
}
export function initialTemplateValues(template:string,config?:unknown):TemplateValues {
  const values:TemplateValues=Object.create(null),metadata=readTemplateConfig(config)
  for(const v of parseVariables(template).variables)values[v.name]=metadata.variables[v.name]?.type==='multi'?(v.defaultValue?[v.defaultValue]:[]):v.defaultValue
  return values
}
function stringValues(values:TemplateValues,config?:unknown):Record<string,string> {
  const result:Record<string,string>=Object.create(null),metadata=readTemplateConfig(config)
  for(const [name,value] of Object.entries(values))result[name]=Array.isArray(value)?value.join(metadata.variables[name]?.separator??'、'):value
  return result
}
export function renderConfiguredTemplate(template:string,values:TemplateValues,config?:unknown):string {
  return renderTemplate(template,stringValues(values,config))
}
export function buildConfiguredFinalPrompt(template:string,values:TemplateValues,original:string,config?:unknown):string {
  return buildFinalPrompt(template,stringValues(values,config),original)
}
export function variableControls(template:string,config?:unknown):Array<TemplateVariable&{type:VariableInputType;options:string[]}> {
  const metadata=readTemplateConfig(config)
  return parseVariables(template).variables.map(v=>({...v,type:metadata.variables[v.name]?.type??(v.name===ORIGINAL_VAR?'textarea':'text'),options:[...(metadata.variables[v.name]?.options??[])]}))
}

