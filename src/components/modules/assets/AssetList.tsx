import { SearchExcerpt } from './SearchExcerpt'
import { Button } from '@/components/ui/button'
import type { AssetPage } from '../../../../shared/assetsContracts'
export function AssetList({ page, selectedId, disabled, onSelect, onPage, onCreate, checkedIds=[],onToggle }: { page: AssetPage; selectedId?: number; disabled: boolean; onSelect: (id: number) => void; onPage: (page: number) => void; onCreate: () => void;checkedIds?:number[];onToggle?:(id:number)=>void }) {
  return <section aria-label="资产列表" className="flex min-h-0 flex-col gap-2">
    <p className="text-xs text-muted-foreground">共 {page.total} 条资产</p>
    <div className="min-h-0 flex-1 overflow-y-auto space-y-2">
      {page.items.map(a => <div key={a.id}>{onToggle&&<label className="flex items-center gap-1 text-xs"><input aria-label={`选择${a.name}`} type="checkbox" disabled={disabled} checked={checkedIds.includes(a.id)} onChange={()=>onToggle(a.id)}/>选择</label>}<button disabled={disabled} aria-pressed={a.id === selectedId} className={`w-full rounded-lg border p-3 text-left hover:bg-accent disabled:opacity-50 ${a.id === selectedId ? 'border-primary bg-accent' : 'border-border'}`} onClick={() => onSelect(a.id)}><strong className="block break-words text-sm">{a.name}</strong>{a.excerpt ? <SearchExcerpt excerpt={a.excerpt} /> : <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{a.description || a.categoryPath.join(' / ')}</p>}<p className="mt-2 text-xs text-muted-foreground">{a.storageType === 'inline_text' ? '文本' : a.storageType === 'file' ? '文件' : '外链'} · {a.currentVersion === null ? '无版本' : `v${a.currentVersion}`} {a.archivedAt ? '· 已归档' : ''}</p><p className="mt-1 break-words text-xs">{a.tags.map(t => `#${t.name}`).join(' ')}</p></button></div>)}
      {!page.items.length && <div className="py-8 text-center text-sm text-muted-foreground"><p>当前范围没有资产。</p><Button className="mt-3" variant="outline" onClick={onCreate} disabled={disabled}>新建资产</Button></div>}
    </div>
    <div className="flex items-center justify-between gap-2"><Button variant="outline" size="sm" disabled={disabled || page.page <= 1} onClick={() => onPage(page.page - 1)}>上一页</Button><span className="text-xs">{page.page} / {Math.max(1, Math.ceil(page.total / page.pageSize))}</span><Button variant="outline" size="sm" disabled={disabled || page.page * page.pageSize >= page.total} onClick={() => onPage(page.page + 1)}>下一页</Button></div>
  </section>
}
