import type {AssetListQuery} from '../../../../shared/assetsContracts'
const defaults:AssetListQuery={page:1,pageSize:30,archived:'exclude'}
const keys=new Set(['q','searchIn','sort','view','page','pageSize','category','kind','tagIds','tagMode','excludeTagIds','storageType','archived','updatedAfter'])
/** Keep other app URL parameters; selection and asset bodies never enter the URL. */
export function assetQueryUrl(href:string,query:AssetListQuery):string {
  const url=new URL(href),value=Object.fromEntries(Object.entries(query).filter(([k,v])=>keys.has(k)&&v!==undefined))
  url.searchParams.set('assetQuery',JSON.stringify(value));return url.href
}
export function readAssetQuery(href:string):AssetListQuery {
  try {
    const raw=new URL(href).searchParams.get('assetQuery')
    if(!raw||raw.length>6000)return {...defaults}
    const value=JSON.parse(raw)
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.has(k)))return {...defaults}
    for(const k of ['page','pageSize'])if(value[k]!==undefined&&(!Number.isSafeInteger(value[k])||value[k]<1||(k==='pageSize'&&value[k]>200)))return {...defaults}
    const enums:Record<string,unknown[]>={view:['all','favorites','recent'],sort:['name','recent','updated','relevance'],searchIn:['all','title','body','source','organization'],kind:[null,'thought','rule','file','prompt'],archived:['exclude','include','only'],tagMode:['and','or'],storageType:['inline_text','file','external_link']}
    for(const [key,options] of Object.entries(enums))if(value[key]!==undefined&&!options.includes(value[key]))return {...defaults}
    for(const key of ['tagIds','excludeTagIds'])if(value[key]!==undefined&&(!Array.isArray(value[key])||value[key].some((id:unknown)=>typeof id!=='number'||!Number.isSafeInteger(id)||id<1)))return {...defaults}
    if(value.q!==undefined&&(typeof value.q!=='string'||value.q.includes('\0')||[...value.q.trim()].length>200))return {...defaults}
    if(value.category!==undefined&&(typeof value.category!=='string'||value.category.trim().length>100||! /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.category.trim())))return {...defaults}
    if(value.updatedAfter!==undefined){if(typeof value.updatedAfter!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.updatedAfter))return {...defaults};const date=new Date(`${value.updatedAfter}T00:00:00.000Z`);if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value.updatedAfter)return {...defaults}}
    return {...defaults,...value}
  }catch{return {...defaults}}
}
