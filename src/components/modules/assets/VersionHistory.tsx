import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetDetail, AssetVersion, VersionDiff, VersionPage, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
import { VersionCompare } from './VersionCompare'
export function VersionHistory({ asset, scope, onRollback, onDownload, onClose }: { asset: AssetDetail; scope: WorkspaceRequest; onRollback: (versionId: number) => Promise<void>; onDownload: (versionId: number) => Promise<void>; onClose: () => void }) {
  const [page, setPage] = useState(1), [versions, setVersions] = useState<VersionPage | null>(null), [version, setVersion] = useState<AssetVersion | null>(null), [diff, setDiff] = useState<VersionDiff | null>(null)
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0)
  const alive = useRef(false), running = useRef(false)
  useAssetsEditorGuard({ isDirty: () => false, isBusy: () => running.current, save: async () => false, discard: onClose })
  useEffect(() => { alive.current = true; let cancelled = false; setBusy(true); running.current = true
    assetsApi.listVersions({ ...scope, assetId: asset.id, page, pageSize: 10 }).then(result => { if (!cancelled) { setVersions(result.page); setError('') } }).catch(error => { if (!cancelled) setError(errorMessage(error)) }).finally(() => { if (!cancelled) { setBusy(false); running.current = false } })
    return () => { cancelled = true; alive.current = false }
  }, [scope, asset.id, asset.revision, page, reload])
  async function action(operation: () => Promise<void>) {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await operation() } catch (error) { if (alive.current) setError(errorMessage(error)) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <AssetModal title={`${asset.name} · 历史版本`} onClose={() => { if (!running.current) onClose() }}>
    <AssetError message={error} />
    {error && <Button variant="outline" size="sm" disabled={busy} onClick={() => setReload(n => n + 1)}>重新读取历史</Button>}
    <div className="space-y-2">{versions?.items.map(v => <div key={v.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-2"><span className="flex-1 text-sm">v{v.version} · {v.createdAt} {v.changelog}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async () => { const result = await assetsApi.getVersion({ ...scope, assetId: asset.id, versionId: v.id }); if (alive.current) setVersion(result.version) })}>读取版本 {v.version}</Button>{asset.storageType === 'file' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => onDownload(v.id))}>下载 v{v.version}</Button>}<Button size="sm" variant="outline" disabled={busy || Boolean(asset.archivedAt)} onClick={() => { if (window.confirm(`回滚到 v${v.version} 将新增版本，保留全部历史。是否继续？`)) void action(() => onRollback(v.id)) }}>回滚 v{v.version}</Button></div>)}</div>
    <div className="flex items-center justify-between"><Button size="sm" variant="outline" disabled={busy || page <= 1} onClick={() => setPage(p => p - 1)}>历史上一页</Button><span className="text-xs">{page} / {Math.max(1, Math.ceil((versions?.total ?? 0) / 10))}</span><Button size="sm" variant="outline" disabled={busy || page * 10 >= (versions?.total ?? 0)} onClick={() => setPage(p => p + 1)}>历史下一页</Button></div>
    <div className="flex flex-wrap gap-2"><select aria-label="比较旧版本" className={`${controlClass} w-auto`} value={from} disabled={busy} onChange={e => setFrom(e.target.value)}><option value="">选择旧版</option>{versions?.items.map(v => <option key={v.id} value={v.id}>v{v.version}</option>)}</select><select aria-label="比较新版本" className={`${controlClass} w-auto`} value={to} disabled={busy} onChange={e => setTo(e.target.value)}><option value="">选择新版</option>{versions?.items.map(v => <option key={v.id} value={v.id}>v{v.version}</option>)}</select><Button disabled={busy || !from || !to} onClick={() => void action(async () => { const result = await assetsApi.diffVersions({ ...scope, assetId: asset.id, fromVersionId: Number(from), toVersionId: Number(to) }); if (alive.current) setDiff(result.diff) })}>比较版本</Button></div>
    {asset.archivedAt && <p className="text-sm text-muted-foreground">归档资产可读取和下载历史；回滚前请先恢复。</p>}
    {version && <section><h3 className="text-sm font-medium">v{version.version} 原文</h3><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3 text-xs">{asset.storageType === 'file' ? version.fileName ?? '未记录文件名' : version.content}</pre></section>}
    {diff && <VersionCompare diff={diff} />}
    {busy && <p role="status" className="text-sm">正在处理版本…</p>}
  </AssetModal>
}
