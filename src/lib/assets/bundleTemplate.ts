import type {AssetDetail,AssetVersion,TaskPackTemplate,TaskPackSectionKey,TaskPackResult} from '../../../shared/assetsContracts'
import {ASSET_TRANSFER_MAX_BYTES} from '../../../shared/assetsContracts'
import {takeAndRecord} from '../../components/modules/assets/assetTake'
import {textBuilder} from './textBudget'
export type {TaskPackTemplate,TaskPackSectionKey} from '../../../shared/assetsContracts'

export type TaskPackAsset=Pick<AssetDetail,'id'|'name'|'kind'|'storageType'|'currentContent'|'externalUrl'|'currentFileName'|'description'|'sourceTask'|'notes'|'sourceJson'>&{
  tags:Array<{name:string}>
  /** Caller explicitly resolves non-AI content before original-only rendering. Empty is meaningful. */
  originalContent?:string
}
export const DEFAULT_TASK_PACK_TEMPLATE:TaskPackTemplate={
  includeHeader:true,includeSource:true,includeNotes:true,includeTags:false,
  sections:[{key:'thought',title:'任务思路'},{key:'rule',title:'规则与约束'},{key:'prompt',title:'可复用 Prompt'},{key:'file',title:'相关文件'},{key:'ordinary',title:'其他资产'}]
}
export function cloneTaskPackTemplate(template:TaskPackTemplate):TaskPackTemplate {
  return {...template,sections:template.sections.map(s=>({...s}))}
}
export function normalizeTaskPackTemplate(input:unknown):TaskPackTemplate {
  const fallback=DEFAULT_TASK_PACK_TEMPLATE
  if(!input||typeof input!=='object'||Array.isArray(input))return cloneTaskPackTemplate(fallback)
  const raw=input as Partial<TaskPackTemplate>,sections:TaskPackTemplate['sections']=[],seen=new Set<string>()
  if(Array.isArray(raw.sections))for(const section of raw.sections) {
    if(!section||typeof section!=='object')continue
    const standard=fallback.sections.find(s=>s.key===section.key)
    if(!standard||seen.has(section.key))continue
    seen.add(section.key)
    sections.push({key:standard.key,title:typeof section.title==='string'&&section.title.trim()?section.title:standard.title})
  }
  for(const section of fallback.sections)if(!seen.has(section.key))sections.push({...section})
  const flag=(value:unknown,defaultValue:boolean)=>typeof value==='boolean'?value:defaultValue
  return {sections,includeHeader:flag(raw.includeHeader,true),includeSource:flag(raw.includeSource,true),includeNotes:flag(raw.includeNotes,true),includeTags:flag(raw.includeTags,false)}
}
export function taskPackSectionKey(kind:unknown):TaskPackSectionKey {
  return kind==='thought'||kind==='rule'||kind==='prompt'||kind==='file'?kind:'ordinary'
}
function aiGenerated(source:string):boolean {
  try{return JSON.parse(source)?.aiGenerated===true}catch{return false}
}
/** Mirrors existing export: highest non-AI version, or current content when none is available. */
export function selectOriginalContent(current:string,versions:Pick<AssetVersion,'version'|'content'|'sourceJson'>[]):string {
  let selected:typeof versions[number]|undefined
  for(const version of versions)if(!aiGenerated(version.sourceJson)&&(!selected||version.version>selected.version))selected=version
  return selected?.content??current
}
export function assetContent(asset:TaskPackAsset,originalOnly=false):string {
  if(asset.storageType==='external_link')return asset.externalUrl??''
  if(asset.storageType==='file')return `文件：${asset.currentFileName??asset.name}\n${asset.description||''}\n（文件本体需另行下载并附上）`
  if(originalOnly&&asset.originalContent===undefined)throw new Error('尚未解析原文，请先读取所选资产的原文版本。')
  return originalOnly?asset.originalContent!:asset.currentContent
}
export function buildTaskPack(assets:TaskPackAsset[],options:{template?:unknown;ai?:'include'|'original-only';maxBytes?:number}={}):TaskPackResult {
  if(!Array.isArray(assets)||assets.length>500)throw new Error('任务包最多选择500项资产。')
  const limit=options.maxBytes??ASSET_TRANSFER_MAX_BYTES
  if(!Number.isSafeInteger(limit)||limit<1||limit>ASSET_TRANSFER_MAX_BYTES)throw new Error('任务包预算非法。')
  if(options.ai!==undefined&&!['include','original-only'].includes(options.ai))throw new Error('任务包原文选项非法。')
  const unique=new Map<number,TaskPackAsset>(),excludedIds:number[]=[],originalOnly=options.ai==='original-only'
  for(const asset of assets) {
    if(!asset||typeof asset.id!=='number'||!Number.isSafeInteger(asset.id)||asset.id<1)throw new Error('任务包资产标识非法。')
    if(!unique.has(asset.id))unique.set(asset.id,asset)
  }
  const groups=new Map<TaskPackSectionKey,TaskPackAsset[]>()
  for(const asset of unique.values()) {
    if(originalOnly&&aiGenerated(asset.sourceJson)){excludedIds.push(asset.id);continue}
    const key=taskPackSectionKey(asset.kind),items=groups.get(key)??[];items.push(asset);groups.set(key,items)
  }
  const template=normalizeTaskPackTemplate(options.template),result=textBuilder(limit),assetIds:number[]=[]
  const append=result.append
  if(template.includeHeader)append(`# 任务包（${unique.size-excludedIds.length} 条）\n`)
  for(const section of template.sections) {
    const items=groups.get(section.key)??[]
    if(!items.length)continue
    append(`\n## ${section.title}\n`)
    for(const asset of items) {
      assetIds.push(asset.id);append(`\n### ${asset.name}\n`)
      if(template.includeSource&&asset.sourceTask)append(`> 来源任务：${asset.sourceTask}\n\n`)
      if(template.includeNotes&&asset.notes)append(`> 备注：${asset.notes}\n\n`)
      if(template.includeTags&&asset.tags.length)append(`> 标签：${asset.tags.map(t=>t.name).join('、')}\n\n`)
      append(assetContent(asset,originalOnly));append('\n')
    }
  }
  return {text:result.finish(),assetIds,excludedIds}
}
export async function copyTaskPack(pack:TaskPackResult,copy:(text:string)=>Promise<unknown>,record:(ids:number[])=>Promise<unknown>):Promise<string> {
  if(!pack.assetIds.length)throw new Error('任务包没有可复制的资产。')
  const ids=[...pack.assetIds],text=pack.text
  return (await takeAndRecord(async()=>{await copy(text);return true},()=>record(ids)))!
}
