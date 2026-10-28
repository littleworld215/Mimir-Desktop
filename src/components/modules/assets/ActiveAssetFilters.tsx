import { Button } from '@/components/ui/button'
import type { AssetCategory,AssetListQuery,AssetTag } from '../../../../shared/assetsContracts'
export function ActiveAssetFilters({query,tags,categories=[],disabled,onRemove}:{query:AssetListQuery;tags:AssetTag[];categories?:AssetCategory[];disabled:boolean;onRemove:(patch:AssetListQuery)=>void}) {
  const chips:Array<{label:string;patch:AssetListQuery}>=[]
  const add=(label:string,patch:AssetListQuery)=>chips.push({label,patch})
  if(query.q)add('检索：'+query.q,{q:undefined})
  if(query.category)add('分类：'+(categories.find(c=>c.code===query.category)?.name??query.category),{category:undefined})
  if(query.storageType)add('形态：'+({inline_text:'文本',file:'文件',external_link:'外链'}[query.storageType]),{storageType:undefined})
  if(query.kind!==undefined)add('类型：'+(query.kind===null?'普通资产':{thought:'想法',rule:'规则',file:'文件资料',prompt:'Prompt'}[query.kind]),{kind:undefined})
  if(query.view&&query.view!=='all')add('范围：'+(query.view==='favorites'?'收藏':'最近使用'),{view:'all'})
  if(query.archived&&query.archived!=='exclude')add('归档：'+(query.archived==='only'?'已归档':'含归档'),{archived:'exclude'})
  if(query.updatedAfter)add('更新起始：'+query.updatedAfter,{updatedAfter:undefined})
  if(query.ids!==undefined)add('指定资产：'+query.ids.length+'项',{ids:undefined})
  if(query.searchIn&&query.searchIn!=='all')add('字段：'+({title:'标题',body:'当前正文',source:'来源',organization:'标题、标签与分类'}[query.searchIn]),{searchIn:'all'})
  if(query.sort)add('排序：'+({relevance:'相关性',updated:'最近更新',name:'名称',recent:'最近使用'}[query.sort]),{sort:undefined})
  if(query.tagMode==='or'&&query.tagIds?.length)add('标签关系：任一',{tagMode:'and'})
  for(const key of ['tagIds','excludeTagIds'] as const)for(const id of query[key]??[])add((key==='tagIds'?'包含标签：':'排除标签：')+(tags.find(t=>t.id===id)?.name??String(id)),{[key]:query[key]?.filter(value=>value!==id)})
  return <div aria-label="已选筛选条件" className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
    {chips.length ? chips.map(chip => <Button
      key={chip.label}
      variant="outline"
      size="sm"
      className="min-w-0 max-w-full"
      disabled={disabled}
      title={chip.label}
      aria-label={'移除筛选 '+chip.label}
      onClick={() => onRemove(chip.patch)}
    >
      <span className="min-w-0 truncate">{chip.label}</span>
      <span aria-hidden="true" className="shrink-0">×</span>
    </Button>) : <span className="text-muted-foreground">未设置额外筛选条件。</span>}
  </div>
}
