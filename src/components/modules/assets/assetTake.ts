import type {AssetCategory,AssetListQuery,AssetTag} from '../../../../shared/assetsContracts'

/** null means cancelled. A record failure is a secondary warning after actual success. */
export async function takeAndRecord(take:()=>Promise<boolean>,record:()=>Promise<unknown>):Promise<string|null> {
  if(!await take())return null
  try {await record();return '取用成功。'} catch(error){return `取用成功；最近使用记录未保存：${error instanceof Error?error.message:'请重试'}`}
}
export function missingFilterConditions(query:AssetListQuery,tags:AssetTag[],categories:AssetCategory[]):string[] {
  const missing:string[]=[]
  if(query.category&&!categories.some(c=>c.code===query.category))missing.push(`分类 ${query.category}`)
  for(const id of new Set([...(query.tagIds??[]),...(query.excludeTagIds??[])]))if(!tags.some(t=>t.id===id))missing.push(`标签 #${id}`)
  return missing
}
export function readPins(raw:string|null):number[] {
  try {const v=JSON.parse(raw??'[]');return Array.isArray(v)?[...new Set(v.filter(id=>typeof id==='number'&&Number.isSafeInteger(id)&&id>0))].slice(0,20):[]}catch{return []}
}
