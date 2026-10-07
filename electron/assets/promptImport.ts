/** Explicit adapter for user-supplied PromptDock/PromptDeck v1 files, independently implemented from the frozen source specification. */
import { createHash } from 'node:crypto'
import { ASSET_TRANSFER_MAX_BYTES, type AssetPromptAdaptation, type TemplateConfig } from '../../shared/assetsContracts'
import { AssetsStoreError } from './types'
import { assertAssetName, assertContentBytes, assertTagName, assertTagCount, assertTemplateConfig } from './validation'

function bad(message:string):never{throw new AssetsStoreError('BAD_REQUEST',message)}
function object(input:unknown):Record<string,unknown>{if(!input||typeof input!=='object'||Array.isArray(input))bad('请选择有效的Prompt JSON对象。');return input as Record<string,unknown>}
export function adaptPromptImport(input:unknown):AssetPromptAdaptation{
  const req=object(input)
  if(Object.keys(req).some(k=>!['raw','convertVariables'].includes(k))||typeof req.raw!=='string'||typeof req.convertVariables!=='boolean')bad('适配参数非法。')
  if(Buffer.byteLength(req.raw,'utf8')>ASSET_TRANSFER_MAX_BYTES)bad('JSON超过200MiB。')
  let parsed:unknown
  try{parsed=JSON.parse(req.raw)}catch{bad('JSON解析失败。')}
  const doc=object(parsed)
  if(!['promptdock','promptdeck'].includes(doc.format as string)||doc.version!==1||!Array.isArray(doc.prompts)||doc.prompts.length>10000)bad('仅支持format=promptdock／promptdeck、version=1的文件，单次最多10000条。')
  const changes:AssetPromptAdaptation['changes']=[],seen=new Set<string>()
  const assets=doc.prompts.map((item,index)=>{
    const p=object(item),name=assertAssetName(p.title),body=assertContentBytes(p.body)
    if(typeof p.id!=='string'||!p.id.trim()||p.id.length>200||seen.has(p.id)||typeof p.folder!=='string'||!Array.isArray(p.tags))bad(`第${index+1}项外部标识、标签或文件夹非法／重复。`)
    seen.add(p.id);assertTagCount(p.tags.length)
    const tags=Array.from(p.tags,assertTagName),config:TemplateConfig={version:1,variables:{}},declarations=new Map<string,string>(),warnings:string[]=[]
    const content=req.convertVariables?body.replace(/\{\{([^{}]*)\}\}/g,(whole:string,inner:string)=>{
      const selection=inner.match(/^([^={}:+]+?)(\+)?=\[([^\]]*)\](?:~([\s\S]*))?$/)
      const text=inner.match(/^([^={}:+]+?)=([\s\S]*)$/)
      if(!selection&&!text)return whole
      const name=(selection?.[1]??text![1]).trim()
      if(!name||name.length>64||['__proto__','constructor','prototype'].includes(name)){warnings.push(`无效变量原样保留：${inner}`);return whole}
      if(declarations.has(name)&&declarations.get(name)!==inner)bad(`同名变量声明不一致：${name}；请选择原样保留或修正源文件。`)
      declarations.set(name,inner)
      if(selection){const options=selection[3].split('|').map(s=>s.trim()),multi=Boolean(selection[2]);config.variables[name]={type:multi?'multi':'single',options,...(multi?{separator:(selection[4]??', ').replace(/\\n/g,'\n').replace(/\\t/g,'\t')}:{})};return `{{${name}${multi?'':':'+options[0]}}}`}
      config.variables[name]={type:'text'};return `{{${name}:${text![2]}}}`
    }):body
    assertTemplateConfig(config)
    changes.push({name,before:body,after:content,warnings})
    return {code:`promptdock-${createHash('sha256').update(p.id).digest('hex').slice(0,32)}`,name,storageType:'inline_text',kind:'prompt',categoryPath:[p.folder.trim()||'Prompt 导入'],content,tags,
      sourceJson:JSON.stringify({format:doc.format,externalId:p.id,originalFavorite:p.favorite===true,originalPinned:p.pinned===true,originalUseCount:typeof p.useCount==='number'?p.useCount:null}),sourceTask:'PromptDock／PromptDeck 文件导入',notes:`原收藏：${p.favorite===true?'是':'否'}；原置顶：${p.pinned===true?'是':'否'}；原使用次数：${typeof p.useCount==='number'?p.useCount:'未提供'}`,...(req.convertVariables?{templateConfig:config}:{})}
  })
  const raw=JSON.stringify({assets})
  if(Buffer.byteLength(raw,'utf8')>ASSET_TRANSFER_MAX_BYTES)bad('适配结果超过200MiB。')
  return {raw,changes,warnings:['只适配用户提供的文件，不导入内置素材；文件夹映射分类路径，收藏、置顶和使用历史保留为来源／备注。']}
}
