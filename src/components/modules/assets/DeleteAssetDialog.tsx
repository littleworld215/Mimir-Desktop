import { useEffect, useRef, useState } from 'react'
import { useAssetPreview } from './useAssetPreview'
import { Button } from '@/components/ui/button'
import type { AssetDeleteImpact, AssetDetail, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetModal, errorMessage, useAssetsEditorGuard } from './assetsUi'
export function DeleteAssetDialog({ asset, scope, onDelete, onClose }: { asset: AssetDetail; scope: WorkspaceRequest; onDelete: (revision: number) => Promise<void>; onClose: () => void }) {
  const [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  const preview = useAssetPreview<AssetDeleteImpact>(), impact = preview.value
  const running = useRef(false)
  useAssetsEditorGuard({ isDirty: () => false, isBusy: () => running.current, save: async () => false, discard: onClose })
  function readPreview() { setConfirmed(false); setError(''); return preview.read(async () => (await assetsApi.deletePreview({ ...scope, assetId: asset.id })).impact) }
  useEffect(() => { void readPreview(); return preview.clear }, [scope, asset.id, preview.read, preview.clear])
  async function remove() { if (!impact || impact.assetId !== asset.id || preview.loading || !confirmed || running.current) return; running.current = true; setBusy(true)
    try { await onDelete(impact.revision) } catch (error) { setError(errorMessage(error)); setConfirmed(false); preview.clear() } finally { running.current = false; setBusy(false) }
  }
  return <AssetModal title="永久删除资产" onClose={() => { if (!running.current) onClose() }}>
    <AssetError message={error || preview.error} />
    {impact ? <><p className="text-sm">{impact.name} · {impact.archived ? '已归档' : '未归档'} · {impact.versionCount} 个版本 · {impact.fileCount} 个文件 · {impact.fileBytes} 字节</p><p className="text-sm text-destructive">永久删除会移除资产及其历史，无法在资产库中恢复。</p><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />我确认删除上述资产及历史</label></> : <Button variant="outline" disabled={busy || preview.loading} onClick={() => void readPreview()}>重新读取删除预览</Button>}
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button variant="destructive" disabled={!impact || impact.assetId !== asset.id || preview.loading || !confirmed || busy} onClick={() => void remove()}>{busy ? '删除中…' : '永久删除'}</Button></div>
  </AssetModal>
}
