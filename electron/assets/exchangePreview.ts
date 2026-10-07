/** A preview is a read-only plan; its token binds content, strategy, scope and every relevant DB row. */
import { createHmac, randomBytes } from 'node:crypto'
import type { AssetImportPreview, ExchangeAsset } from '../../shared/assetsContracts'
import type { AssetsContext, AssetsWriteSession } from './types'
import type { ParsedImport } from './exchangeParse'
import { portable } from './exchangeExport'
import type { AssetRow } from './assetRepository'

const tokenKey = randomBytes(32)
export function importToken(ctx: AssetsContext,s: AssetsWriteSession,r: ParsedImport): string {
  const hash = createHmac('sha256',tokenKey)
  for (const value of [ctx.scope,r.raw,r.mode,r.skipIndexes]) hash.update(JSON.stringify(value)).update('\n')
  for (const [table,order] of [['asset','id'],['asset_version','id'],['asset_category','code'],['tag','id'],['asset_tag','asset_id,tag_id'],['asset_reference','source_asset_id,target_asset_id']]) {
    hash.update(table)
    for (const row of s.all(`SELECT * FROM ${table} ORDER BY ${order}`)) hash.update(JSON.stringify(row)).update('\n')
  }
  return hash.digest('hex')
}
export function categoryPathExists(s: AssetsWriteSession,path: string[]): boolean {
  let parent: string | null = null
  for (const name of path) {
    const row: {code:string} | undefined = s.get('SELECT code FROM asset_category WHERE name=? AND parent_code IS ? ORDER BY code LIMIT 1',name,parent)
    if (!row) return false
    parent = row.code
  }
  return path.length > 0
}
function unique(code: string, reserved: Set<string>): string {
  let n=1, candidate=code
  while (reserved.has(candidate)) {
    const suffix=`-copy-${n++}`
    candidate=code.slice(0,100-suffix.length).replace(/-+$/,'')+suffix
  }
  reserved.add(candidate)
  return candidate
}
export function previewInSession(ctx: AssetsContext,s: AssetsWriteSession,r: ParsedImport): AssetImportPreview {
  const existing = new Map(s.all<AssetRow>('SELECT * FROM asset ORDER BY id').map(a=>[a.code,a]))
  const reserved = new Set([...existing.keys(),...r.rows.flatMap(row=>row.asset ? [row.asset.code] : [])])
  const seen = new Set<string>(), skipped = new Set(r.skipIndexes)
  const p: AssetImportPreview = { previewToken: importToken(ctx,s,r), canCommit: true, created:0,updated:0,skipped:0,filesMissing:0,categoriesMissing:[],referencesMissing:[],errors:[],duplicates:[],rows:[] }
  const signature = (a: ExchangeAsset) => JSON.stringify([a.storageType,a.storageType==='inline_text' ? a.content : a.storageType==='external_link' ? a.externalUrl : a.name])
  const byContent = new Map<string,string[]>()
  for (const current of existing.values()) {
    const value = portable(s,current.id,false) as ExchangeAsset, key=signature(value)
    byContent.set(key,[...(byContent.get(key) ?? []),current.code])
  }
  for (const row of r.rows) {
    const a=row.asset, old=a ? existing.get(a.code) : undefined
    let error = row.error, action: 'create'|'update'|'skip'|'error' = skipped.has(row.index) ? 'skip' : old && r.mode==='skip' ? 'skip' : old && r.mode==='overwrite' ? 'update' : 'create'
    if (a && !skipped.has(row.index)) {
      if (seen.has(a.code)) error='同批code重复，请显式跳过重复行。'
      seen.add(a.code)
      if (action==='update' && old?.storage_type!==a.storageType) error='覆盖不能改变内容形式，请选择复制或跳过。'
    }
    if (error && (row.fatal || action!=='skip')) { p.errors.push({index:row.index,message:error}); action='error' }
    const targetCode = a && action==='create' && old ? unique(a.code,reserved) : a?.code ?? ''
    const before = old ? portable(s,old.id,false) : null
    p.rows.push({index:row.index,code:a?.code ?? '',targetCode,action,before,after:a,warnings:[]})
    if (action==='error') continue
    if (action==='skip') { p.skipped++; continue }
    if (!a) continue
    if (action==='create') p.created++; else p.updated++
    if (a.storageType==='file') { p.filesMissing++; p.rows[p.rows.length-1].warnings.push(action==='update' ? '交换不含文件字节，保留本地文件版本。' : '交换不含文件字节，创建文件空壳。') }
    if (!s.get('SELECT code FROM asset_category WHERE code=?',a.category) && !categoryPathExists(s,a.categoryPath)) p.categoriesMissing.push((a.categoryPath.length ? a.categoryPath : [a.category]).join(' / '))
    const matches = [...new Set([...(byContent.get(signature(a)) ?? []),...(old ? [old.code] : [])])]
    if (matches.length) p.duplicates.push({index:row.index,code:a.code,matches})
    byContent.set(signature(a),[...(byContent.get(signature(a)) ?? []),a.code])
  }
  const incoming = new Map(p.rows.filter(x=>x.action==='create'||x.action==='update').map(x=>[x.code,x.targetCode]))
  for (const row of p.rows) {
    if (row.action!=='create' && row.action!=='update') continue
    for (const ref of row.after?.references ?? []) {
      const target=incoming.get(ref) ?? ref
      if (target===row.targetCode) row.warnings.push('自参见将忽略。')
      else if (!incoming.has(ref) && !existing.has(ref)) { p.referencesMissing.push(ref); row.warnings.push(`参见 ${ref} 不存在，将忽略。`) }
    }
  }
  p.canCommit=p.errors.length===0
  p.categoriesMissing=[...new Set(p.categoriesMissing)]
  p.referencesMissing=[...new Set(p.referencesMissing)]
  return p
}
