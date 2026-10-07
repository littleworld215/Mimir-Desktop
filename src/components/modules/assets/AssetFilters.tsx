import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetListQuery, AssetTag } from '../../../../shared/assetsContracts'
import { controlClass } from './assetsUi'

export function AssetFilters({ query, tags, disabled, onChange }: { query: AssetListQuery; tags: AssetTag[]; disabled: boolean; onChange: (patch: AssetListQuery) => Promise<void> }) {
  const [draft, setDraft] = useState(query.q ?? ''), [composing, setComposing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(), change = useRef(onChange)
  change.current = onChange
  function cancel() { clearTimeout(timer.current) }
  function submit(value: string) { cancel(); void change.current({ q: value.trim() || undefined }) }
  useEffect(() => { setDraft(query.q ?? '') }, [query.q])
  useEffect(() => {
    cancel()
    if (!composing && draft.trim() !== (query.q ?? '')) timer.current = setTimeout(() => submit(draft), 300)
    return cancel
  }, [draft, composing, query.q])
  const selectClass = controlClass.replace('w-full ', '') + ' w-auto'
  return <section aria-label="资产检索与筛选" className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <input aria-label="检索资产" placeholder="检索标题、正文与科研资料…" className={controlClass.replace('w-full ', '') + ' min-w-48 flex-1'} disabled={disabled} value={draft} maxLength={400} onChange={e => setDraft(e.target.value)} onCompositionStart={() => { cancel(); setComposing(true) }} onCompositionEnd={e => { setDraft(e.currentTarget.value); setComposing(false) }} onKeyDown={e => { if (e.key === 'Enter' && !composing && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(draft) } }} />
      <select aria-label="检索范围" className={selectClass} disabled={disabled} value={query.searchIn ?? 'all'} onChange={e => void onChange({ searchIn: e.target.value as AssetListQuery['searchIn'] })}>{[['all', '全部字段'], ['title', '标题'], ['body', '当前正文'], ['source', '来源'], ['organization', '标题、标签与分类']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="排序方式" className={selectClass} disabled={disabled} value={query.sort ?? ''} onChange={e => void onChange({ sort: e.target.value ? e.target.value as AssetListQuery['sort'] : undefined })}><option value="">自动排序</option><option value="relevance">相关性</option><option value="updated">最近更新</option><option value="name">名称</option><option value="recent">最近使用</option></select>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => { cancel(); setDraft(''); setComposing(false); void onChange({ view: 'all', q: undefined, searchIn: 'all', sort: undefined, kind: undefined, updatedAfter: undefined, excludeTagIds: [], ids: undefined, category: undefined, storageType: undefined, tagIds: [], tagMode: 'and', archived: 'exclude' }) }}>清空筛选</Button>
    </div>
    <select aria-label="取用范围" className={selectClass} disabled={disabled} value={query.view ?? 'all'} onChange={e => void onChange({ view: e.target.value as AssetListQuery['view'] })}><option value="all">全部资产</option><option value="favorites">收藏</option><option value="recent">最近使用</option></select><details><summary className="cursor-pointer text-sm">更多筛选</summary><div className="mt-2 flex flex-wrap gap-2">
      <select aria-label="归档范围" className={selectClass} disabled={disabled} value={query.archived ?? 'exclude'} onChange={e => void onChange({ archived: e.target.value as AssetListQuery['archived'] })}><option value="exclude">未归档</option><option value="only">已归档</option><option value="include">含归档</option></select>
      <select aria-label="形态筛选" className={selectClass} disabled={disabled} value={query.storageType ?? ''} onChange={e => void onChange({ storageType: e.target.value ? e.target.value as AssetListQuery['storageType'] : undefined })}><option value="">全部形态</option><option value="inline_text">文本</option><option value="file">文件</option><option value="external_link">外链</option></select>
      <select aria-label="条目类型" className={selectClass} disabled={disabled} value={query.kind === null ? 'ordinary' : query.kind ?? ''} onChange={e => void onChange({ kind: e.target.value === 'ordinary' ? null : e.target.value ? e.target.value as AssetListQuery['kind'] : undefined })}>{[['', '全部类型'], ['ordinary', '普通资产'], ['thought', '想法'], ['rule', '规则'], ['file', '文件资料'], ['prompt', 'Prompt']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <input aria-label="更新起始日期" type="date" className={selectClass} disabled={disabled} value={query.updatedAfter ?? ''} onChange={e => void onChange({ updatedAfter: e.target.value || undefined })} />
      <select aria-label="标签匹配方式" className={selectClass} disabled={disabled} value={query.tagMode ?? 'and'} onChange={e => void onChange({ tagMode: e.target.value as 'and' | 'or' })}><option value="and">全部标签匹配</option><option value="or">任一标签匹配</option></select>
    </div><div className="mt-2 flex flex-wrap gap-3">{tags.map(tag => <div key={tag.id} className="flex gap-2 text-xs">{(['tagIds', 'excludeTagIds'] as const).map(field => <label key={field} className="flex items-center gap-1"><input type="checkbox" aria-label={`${field === 'tagIds' ? '包含' : '排除'}标签 ${tag.name}`} disabled={disabled} checked={query[field]?.includes(tag.id) ?? false} onChange={e => void onChange({ [field]: e.target.checked ? [...(query[field] ?? []), tag.id] : query[field]?.filter(id => id !== tag.id) })} />{field === 'tagIds' ? '包含' : '排除'} {tag.name}</label>)}</div>)}</div></details>
  </section>
}
