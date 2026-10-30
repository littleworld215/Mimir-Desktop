import { useEffect, useRef, useState } from 'react'
import type { AssetListQuery, AssetTag, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { readFrequentAssetTags, writeFrequentAssetTags } from '@/lib/assetTagPreferences'
interface Props { scope: WorkspaceRequest; tags: AssetTag[]; query: AssetListQuery; disabled: boolean; onChange(patch: AssetListQuery): Promise<void> }
export function FrequentTags({ scope, tags, query, disabled, onChange }: Props) {
  const identity = JSON.stringify([scope.workspaceId, scope.spaceEpoch]), current = useRef(identity); current.current = identity
  const [state, setState] = useState<{ identity: string; ids: number[]; readable: boolean }>(), [warning, setWarning] = useState(''), [selected, setSelected] = useState(''), [pending, setPending] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setSelected(''); setPending(false)
    try { const result = readFrequentAssetTags(localStorage, scope.workspaceId); setState({ identity, ids: result.ids, readable: !result.warning }); setWarning(result.warning ?? '') }
    catch { setState({ identity, ids: [], readable: false }); setWarning('常用标签存储不可用；原筛选保留。') }
  }, [identity, attempt])
  useEffect(() => () => { current.current = '' }, [])
  const ready = state?.identity === identity && state.readable, pinned = state?.identity === identity ? state.ids : []
  const locked = disabled || pending || !ready
  function persist(next: number[]) {
    if (locked) return
    try {
      const result = writeFrequentAssetTags(localStorage, scope.workspaceId, next)
      if (!result.ok) { setWarning(result.message ?? '常用标签保存失败。'); return }
      setState({ identity, ids: next, readable: true }); setWarning(''); setSelected('')
    } catch { setWarning('常用标签存储不可用，原偏好与筛选保留。') }
  }
  async function include(id: number) {
    if (locked || !tags.some(tag => tag.id === id)) return
    const owner = identity
    setPending(true); setWarning('')
    try { await onChange({ tagIds: query.tagIds?.includes(id) ? query.tagIds.filter(value => value !== id) : [...(query.tagIds ?? []), id] }) }
    catch (failure) { if (current.current === owner) setWarning(failure instanceof Error ? failure.message : '筛选失败，原条件保留。') }
    finally { if (current.current === owner) setPending(false) }
  }
  return <section aria-label="常用标签" className="space-y-2 rounded border border-border p-2 text-sm text-foreground">
    <p className="text-xs text-muted-foreground">常用标签 · 仅本机、当前科研空间，不随业务备份同步；最多20个。</p>
    {warning && <p role="alert" className="break-words text-xs text-destructive">{warning}</p>}
    {!ready && <button type="button" className="rounded border px-2 py-1" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>重试读取常用标签</button>}
    <div className="flex flex-wrap gap-2">{pinned.map(id => { const tag = tags.find(value => value.id === id), name = tag?.name ?? `已失效标签 #${id}`; return <div key={id} className="flex max-w-full gap-1"><button type="button" aria-label={`常用标签 ${name}`} aria-pressed={query.tagIds?.includes(id) ?? false} className="break-words rounded border px-2 py-1 aria-pressed:bg-muted focus-visible:ring-2 focus-visible:ring-ring" disabled={locked || !tag} onClick={() => void include(id)}>{name}</button><button type="button" aria-label={`取消常用标签 ${name}`} className="rounded border px-1 focus-visible:ring-2 focus-visible:ring-ring" disabled={locked} onClick={() => persist(pinned.filter(value => value !== id))}>×</button></div> })}</div>
    <details><summary className="cursor-pointer text-xs">管理常用标签</summary><div className="mt-2 flex flex-wrap gap-2"><label className="min-w-0 max-w-full">设为常用的标签 <select aria-label="设为常用的标签" className="max-w-full rounded border border-border bg-background p-1 text-foreground" value={selected} disabled={locked} onChange={event => setSelected(event.target.value)}><option value="">请选择</option>{tags.filter(tag => !pinned.includes(tag.id)).map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label><button type="button" className="rounded border px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring" disabled={locked || !selected} onClick={() => { const id = Number(selected); if (tags.some(tag => tag.id === id)) persist([...pinned, id]) }}>添加常用标签</button></div></details>
  </section>
}
