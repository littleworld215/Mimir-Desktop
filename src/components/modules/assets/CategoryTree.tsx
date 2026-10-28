import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetCategory } from '../../../../shared/assetsContracts'
export function CategoryTree({ categories, current, disabled, onSelect, onEdit }: { categories: AssetCategory[]; current?: string; disabled: boolean; onSelect: (code?: string) => void; onEdit: (category?: AssetCategory) => void }) {
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set())
  useEffect(() => {
    setCollapsed(old => {
      const next = new Set(old)
      const seen = new Set<string>()
      let code = current
      while (code && !seen.has(code)) {
        seen.add(code)
        const parent = categories.find(c => c.code === code)?.parentCode
        if (!parent) break
        next.delete(parent)
        code = parent
      }
      return next.size === old.size ? old : next
    })
  }, [current, categories])
  function depth(category: AssetCategory): number {
    const seen = new Set<string>(); let parent = category.parentCode, count = 0
    while (parent && !seen.has(parent)) { seen.add(parent); ++count; parent = categories.find(c => c.code === parent)?.parentCode ?? null }
    return count
  }
  const byCode = new Map(categories.map(c => [c.code, c]))
  const paths = new Map(categories.map(category => {
    const seen = new Set<string>(), path: AssetCategory[] = []
    let cursor: AssetCategory | undefined = category
    while (cursor && !seen.has(cursor.code)) { seen.add(cursor.code); path.unshift(cursor); cursor = cursor.parentCode ? byCode.get(cursor.parentCode) : undefined }
    return [category.code, path] as const
  }))
  const sorted = [...categories].sort((a, b) => {
    const left = paths.get(a.code)!, right = paths.get(b.code)!
    for (let i = 0; i < Math.min(left.length, right.length); ++i) {
      if (left[i]!.code !== right[i]!.code) return left[i]!.sortOrder - right[i]!.sortOrder || left[i]!.code.localeCompare(right[i]!.code)
    }
    return left.length - right.length
  })
  return <nav aria-label="资产分类" className="space-y-1"><Button variant="outline" className="w-full" disabled={disabled} onClick={() => onSelect()}>全部分类</Button><p className="text-xs text-muted-foreground">数字为直属资产数，按当前归档范围；选择分类包含子分类。</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={()=>setCollapsed(new Set())}>展开全部</Button><Button variant="outline" size="sm" disabled={disabled} onClick={()=>setCollapsed(new Set(categories.filter(c=>categories.some(child=>child.parentCode===c.code)).map(c=>c.code)))}>折叠全部</Button></div>{sorted.filter(c=>(paths.get(c.code)??[]).slice(0,-1).every(parent=>!collapsed.has(parent.code))).map(c => <div key={c.code} className="flex items-center gap-1">{categories.some(child=>child.parentCode===c.code)&&<button type="button" disabled={disabled} aria-label={(collapsed.has(c.code)?'展开分类 ':'折叠分类 ')+c.name} aria-expanded={!collapsed.has(c.code)} className="shrink-0 rounded px-2 py-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>setCollapsed(old=>{const next=new Set(old);if(next.has(c.code))next.delete(c.code);else next.add(c.code);return next})}>{collapsed.has(c.code)?'▸':'▾'}</button>}<button disabled={disabled} aria-pressed={current === c.code} className={`min-w-0 flex-1 rounded px-2 py-2 text-left text-sm hover:bg-accent ${current === c.code ? 'bg-accent font-medium' : ''}`} style={{ paddingLeft: 8 + depth(c) * 14 }} onClick={() => onSelect(c.code)}>{c.name} <span className="text-xs text-muted-foreground">{c.assetCount ?? 0}</span></button><button aria-label={`编辑分类 ${c.name}`} className="text-xs text-muted-foreground" disabled={disabled} onClick={() => onEdit(c)}>编辑</button></div>)}<Button variant="outline" size="sm" className="mt-3 w-full" disabled={disabled} onClick={() => onEdit()}>新建分类</Button></nav>
}
