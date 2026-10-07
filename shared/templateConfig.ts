import type {TemplateConfig,TemplateConfigVariable} from './assetsContracts'

/** Browser-safe metadata reader. Invalid optional metadata keeps legacy text behavior. */
export function readTemplateConfig(input:unknown):TemplateConfig {
  const empty=():TemplateConfig=>({version:1,variables:Object.create(null)})
  try {
    const value=typeof input==='string'?JSON.parse(input):input
    if(!value||typeof value!=='object'||Array.isArray(value))return empty()
    const raw=value as Record<string,unknown>
    if(raw.version!==1||!raw.variables||typeof raw.variables!=='object'||Array.isArray(raw.variables)||Object.keys(raw).some(k=>!['version','variables'].includes(k)))return empty()
    const entries=Object.entries(raw.variables)
    if(entries.length>100||JSON.stringify(value).length>64000)return empty()
    const variables:TemplateConfig['variables']=Object.create(null)
    for(const [name,item] of entries) {
      if(!name.trim()||name!==name.trim()||name.length>64||/[{}:]/.test(name)||['__proto__','constructor','prototype'].includes(name))return empty()
      if(!item||typeof item!=='object'||Array.isArray(item))return empty()
      const config=item as Record<string,unknown>
      if(typeof config.type!=='string'||!['text','textarea','single','multi'].includes(config.type)||Object.keys(config).some(k=>!['type','options','separator'].includes(k)))return empty()
      const options=config.options
      if(options!==undefined&&(!Array.isArray(options)||options.length>100||Array.from(options).some(v=>typeof v!=='string'||!v.length||v.length>500)||new Set(options).size!==options.length))return empty()
      if(['single','multi'].includes(config.type)&&(!Array.isArray(options)||!options.length))return empty()
      if(config.separator!==undefined&&(typeof config.separator!=='string'||config.separator.length>100))return empty()
      variables[name]={type:config.type as TemplateConfigVariable['type'],...(options===undefined?{}:{options:[...options as string[]]}),...(config.separator===undefined?{}:{separator:config.separator as string})}
    }
    return {version:1,variables}
  }catch{return empty()}
}
