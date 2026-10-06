import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetTag, TagImpact, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
import { useAssetPreview } from './useAssetPreview'
import { requestAssetsLeave } from '@/lib/assetsEditGuard'
export function TagManager({ tags, scope, write, onChanged, onClose }: { tags: AssetTag[]; scope: WorkspaceRequest; write: <T>(operation: (scope: WorkspaceRequest) => Promise<T>) => Promise<T>; onChanged: () => void; onClose: () => void }) {
  const [selected, setSelected] = useState<AssetTag | null>(null), [name, setName] = useState(''), [target, setTarget] = useState(''), [confirmed, setConfirmed] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const preview = useAssetPreview<TagImpact>(), impact = preview.value
  const running = useRef(false), dirty = name !== (selected?.name ?? '')
  function reset() { setSelected(null); setName(''); preview.clear(); setTarget(''); setConfirmed(false) }
  async function save(): Promise<boolean> { if (running.current) return false; running.current = true; setBusy(true); setError('')
    try { await write(context => selected ? assetsApi.renameTag({ ...context, tagId: selected.id, expectedRevision: selected.revision, name }) : assetsApi.createTag({ ...context, name })); reset(); onChanged(); return true }
    catch (error) { setError(errorMessage(error)); return false } finally { running.current = false; setBusy(false) }
  }
  useAssetsEditorGuard({ isDirty: () => dirty, isBusy: () => running.current, save, discard: reset })
  async function govern(merge: boolean) { if (!selected || !impact || impact.tagId !== selected.id || preview.loading || !confirmed || running.current) return; const targetTag = tags.find(t => String(t.id) === target); if (merge && !targetTag) return; running.current = true; setBusy(true); setError('')
    try { await write(async context => { if (merge && targetTag) await assetsApi.mergeTags({ ...context, sourceId: selected.id, targetId: targetTag.id, expectedSourceRevision: selected.revision, expectedTargetRevision: targetTag.revision, confirm: true }); else await assetsApi.deleteTag({ ...context, tagId: selected.id, expectedRevision: selected.revision, confirm: true }) }); reset(); onChanged() }
    catch (error) { setError(errorMessage(error)); preview.clear(); setConfirmed(false) } finally { running.current = false; setBusy(false) }
  }
  return <AssetModal title="标签管理" onClose={() => { if (!running.current) void requestAssetsLeave().then(ok => { if (ok) onClose() }) }}>
    <div className="max-h-48 overflow-auto flex flex-wrap gap-2">{tags.map(t => <Button key={t.id} variant={t.id === selected?.id ? 'default' : 'outline'} size="sm" disabled={busy} onClick={() => void requestAssetsLeave().then(ok => { if (ok) { setSelected(t); setName(t.name); preview.clear(); setConfirmed(false); setTarget(''); setError('') } })}>{t.name}</Button>)}<Button size="sm" variant="outline" disabled={busy} onClick={() => void requestAssetsLeave().then(ok => { if (ok) reset() })}>新建标签</Button></div>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}><AssetField label={selected ? '标签新名称' : '新标签名称'}><input className={controlClass} value={name} required disabled={busy} onChange={e => { setName(e.target.value); preview.clear(); setConfirmed(false) }} /></AssetField><AssetError message={error || preview.error} /><Button disabled={busy || !name.trim()}>{busy ? '处理中…' : selected ? '保存标签名称' : '创建标签'}</Button></form>
    {selected && <section className="space-y-3 border-t border-border pt-3"><Button variant="outline" disabled={busy || preview.loading} onClick={() => { setConfirmed(false); void preview.read(async () => (await assetsApi.tagImpact({ ...scope, tagId: selected.id, targetName: name })).impact).then(result => { if (result?.conflictTagId) setTarget(String(result.conflictTagId)) }) }}>读取治理影响</Button>{impact && <><p className="text-sm">影响 {impact.assetCount} 条资产（包含归档）。正文和历史版本保留。</p>{impact.conflictTagId && <p className="text-sm">名称已存在，请选择合并。</p>}<AssetField label="合并到标签"><select className={controlClass} value={target} disabled={busy} onChange={e => { setTarget(e.target.value); setConfirmed(false) }}><option value="">选择目标标签</option>{tags.filter(t => t.id !== selected.id).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></AssetField><label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认上述标签影响</label><div className="flex gap-2"><Button disabled={busy || !confirmed || !target} onClick={() => void govern(true)}>合并标签</Button><Button variant="destructive" disabled={busy || !confirmed || dirty} onClick={() => void govern(false)}>删除标签</Button></div></>}</section>}
  </AssetModal>
}
