import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetDetail, AssetPage, AssetReferences as References, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
import { useAssetPreview } from './useAssetPreview'
import { ReferenceGraph } from './ReferenceGraph'

export function AssetReferences({ asset, scope, disabled, write, onChanged, onSelect }: { asset: AssetDetail; scope: WorkspaceRequest; disabled: boolean; write: <T>(op: (context: WorkspaceRequest) => Promise<T>) => Promise<T>; onChanged: () => Promise<void>; onSelect: (id: number) => void }) {
  const references = useAssetPreview<{ references: References }>(), lookup = useAssetPreview<{ page: AssetPage }>(), target = useAssetPreview<{ asset: AssetDetail }>()
  const [query, setQuery] = useState(''), [chosen, setChosen] = useState<number | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(false)
  const busy = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useAssetsEditorGuard({ isDirty: () => false, isBusy: () => busy.current, save: async () => false, discard: () => {} })
  function read() { return references.read(() => assetsApi.references({ ...scope, assetId: asset.id })) }
  useEffect(() => { void read(); return references.clear }, [asset.id, asset.revision, scope.workspaceId, scope.spaceEpoch])
  async function mutate(targetAssetId: number, remove = false) {
    if (busy.current) return
    busy.current = true; setPending(true); setError(''); setNotice('')
    try {
      const result = await write(context => (remove ? assetsApi.removeReference : assetsApi.addReference)({ ...context, sourceAssetId: asset.id, targetAssetId, expectedRevision: asset.revision }))
      if (!alive.current) return
      setNotice(result.changed ? remove ? '参见已移除。' : '参见已添加。' : '关系未改变。')
      if (!remove) { setChosen(null); setQuery(''); target.clear(); lookup.clear() }
      await onChanged()
      if (alive.current) await read()
    } catch (error) { if (alive.current) setError(errorMessage(error)) }
    finally { busy.current = false; if (alive.current) setPending(false) }
  }
  const locked = disabled || pending, readonly = locked || !!asset.archivedAt
  const data = references.value?.references
  return <section aria-label="资产参见" className="mt-4 space-y-3 rounded-lg border p-3">
    <h2 className="text-sm font-medium">参见与被参见</h2><AssetError message={references.error} />{references.loading && <p role="status">正在读取参见…</p>}{references.error && <Button size="sm" variant="outline" disabled={locked} onClick={() => void read()}>重试读取参见</Button>}
    {data && <div className="grid gap-3 sm:grid-cols-2">{(['references', 'referencedBy'] as const).map(field => <div key={field}><h3 className="text-xs text-muted-foreground">{field === 'references' ? '参见' : '被参见'}</h3><ul>{data[field].map(related => <li key={related.id} className="flex flex-wrap items-center gap-1"><Button size="sm" variant="ghost" disabled={locked} onClick={() => onSelect(related.id)}>{related.name}{related.archivedAt ? '（已归档）' : ''}</Button>{field === 'references' && <Button size="sm" variant="outline" aria-label={`移除参见 ${related.name}`} disabled={readonly} onClick={() => void mutate(related.id, true)}>移除</Button>}</li>)}</ul>{!data[field].length && <p className="text-xs text-muted-foreground">暂无关系</p>}</div>)}</div>}
    {asset.archivedAt && <p className="text-xs text-muted-foreground">恢复此资产后可调整参见。</p>}
    <div className="flex flex-wrap gap-2"><input aria-label="查找关联资产" placeholder="查找要参见的资产" className={controlClass.replace('w-full ', '') + ' min-w-40 flex-1'} disabled={readonly} value={query} onChange={e => { setQuery(e.target.value); setChosen(null); target.clear(); lookup.clear() }} /><Button size="sm" variant="outline" disabled={readonly} onClick={() => void lookup.read(() => assetsApi.list({ ...scope, q: query.trim() || undefined, archived: 'include', page: 1, pageSize: 10 }))}>查找目标</Button></div>
    <AssetError message={lookup.error || target.error} />{(lookup.loading || target.loading) && <p role="status">正在读取关联目标…</p>}
    <div className="flex flex-wrap gap-1">{lookup.value?.page.items.filter(item => item.id !== asset.id).map(item => <Button key={item.id} size="sm" variant="outline" disabled={readonly} aria-label={`选择关联资产 ${item.name}`} onClick={() => { setChosen(item.id); void target.read(() => assetsApi.get({ ...scope, assetId: item.id })) }}>{item.name}{item.archivedAt ? '（已归档）' : ''}</Button>)}</div>
    {lookup.value && !lookup.value.page.items.some(item => item.id !== asset.id) && <p className="text-xs text-muted-foreground">没有可关联的目标。</p>}
    {target.value?.asset.id === chosen && <p className="text-sm">已选择：{target.value.asset.name}</p>}
    <Button size="sm" disabled={readonly || !chosen || target.value?.asset.id !== chosen} onClick={() => { if (chosen) void mutate(chosen) }}>添加参见</Button>
    <AssetError message={error} />{error && <Button size="sm" variant="outline" disabled={locked} onClick={() => void onChanged().catch(e => { if (alive.current) setError(errorMessage(e)) })}>重新加载资产与关系</Button>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <ReferenceGraph key={asset.revision} scope={scope} assetId={asset.id} disabled={locked} onSelect={onSelect} />
  </section>
}
