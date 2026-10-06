import { Button } from '@/components/ui/button'
import type { AssetCategory } from '../../../../shared/assetsContracts'
export function CategoryTree({ categories, current, disabled, onSelect, onEdit }: { categories: AssetCategory[]; current?: string; disabled: boolean; onSelect: (code?: string) => void; onEdit: (category?: AssetCategory) => void }) {
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
  return <nav aria-label="资产分类" className="space-y-1"><Button variant="outline" className="w-full" disabled={disabled} onClick={() => onSelect()}>全部分类</Button>{sorted.map(c => <div key={c.code} className="flex items-center gap-1"><button disabled={disabled} aria-pressed={current === c.code} className={`min-w-0 flex-1 rounded px-2 py-2 text-left text-sm hover:bg-accent ${current === c.code ? 'bg-accent font-medium' : ''}`} style={{ paddingLeft: 8 + depth(c) * 14 }} onClick={() => onSelect(c.code)}>{c.name} <span className="text-xs text-muted-foreground">{c.assetCount ?? 0}</span></button><button aria-label={`编辑分类 ${c.name}`} className="text-xs text-muted-foreground" disabled={disabled} onClick={() => onEdit(c)}>编辑</button></div>)}<Button variant="outline" size="sm" className="mt-3 w-full" disabled={disabled} onClick={() => onEdit()}>新建分类</Button></nav>
}
