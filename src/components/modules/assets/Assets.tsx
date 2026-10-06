import { useState } from 'react'
import { Boxes, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { requestAssetsLeave } from '@/lib/assetsEditGuard'
import type { AssetCategory, AssetCreateInput, AssetDetail as Detail, AssetListQuery, AssetPatch } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { useAssets } from './useAssets'
import { AssetEditor } from './AssetEditor'
import { AssetList } from './AssetList'
import { AssetDetail } from './AssetDetail'
import { CategoryTree } from './CategoryTree'
import { CategoryEditor } from './CategoryEditor'
import { TagManager } from './TagManager'
import { VersionHistory } from './VersionHistory'
import { DeleteAssetDialog } from './DeleteAssetDialog'
import { AssetError, controlClass, errorMessage } from './assetsUi'
type Modal = { kind: 'edit'; asset?: Detail } | { kind: 'category'; category?: AssetCategory } | { kind: 'tags' | 'history' | 'delete' } | null

export function Assets(): React.JSX.Element {
  const data = useAssets(), [modal, setModal] = useState<Modal>(null), [notice, setNotice] = useState('')
  const disabled = data.busy || !data.scope
  async function open(next: Modal) { if (await requestAssetsLeave()) setModal(next) }
  async function filter(patch: AssetListQuery) { if (!await requestAssetsLeave()) return; setModal(null); data.accept(null); data.setQuery(q => ({ ...q, page: 1, ...patch })) }
  async function refreshAll() { await data.refresh(); if (data.selected) await data.select(data.selected.id) }
  async function save(input: AssetCreateInput | AssetPatch) {
    const editing = modal?.kind === 'edit' ? modal.asset : undefined
    const result = await data.write(context => editing ? assetsApi.update({ ...context, assetId: editing.id, expectedRevision: editing.revision, expectedCurrentVersionId: editing.currentVersionId, patch: input }) : assetsApi.create({ ...context, input: input as AssetCreateInput }))
    data.accept(result.asset); setModal(null); setNotice('资产已保存。'); void data.refresh()
  }
  async function perform(operation: () => Promise<void>) { try { await operation() } catch (error) { data.setError(errorMessage(error)) } }
  async function archive() {
    const asset = data.selected; if (!asset) return
    const result = await data.write(context => asset.archivedAt ? assetsApi.restore({ ...context, assetId: asset.id, expectedRevision: asset.revision }) : assetsApi.archive({ ...context, assetId: asset.id, expectedRevision: asset.revision }))
    data.accept(result.asset); setNotice(asset.archivedAt ? '资产已恢复。' : '资产已归档，历史与文件保留。'); void data.refresh()
  }
  async function importFile() {
    const asset = data.selected; if (!asset) return
    const result = await data.write(async context => {
      const selected = await window.electronAPI!.showOpenDialog({ title: '选择资产文件', properties: ['openFile'] }) as { canceled: boolean; filePaths: string[] }
      if (selected.canceled || !selected.filePaths[0]) return null
      return assetsApi.importFile({ ...context, assetId: asset.id, expectedRevision: asset.revision, expectedCurrentVersionId: asset.currentVersionId, sourcePath: selected.filePaths[0] })
    })
    if (result) { data.accept(result.asset); setNotice('文件已导入并新增版本。'); void data.refresh() }
  }
  async function download(versionId?: number) {
    const asset = data.selected; if (!asset) return
    const result = await data.write(async context => {
      const path = await window.electronAPI!.showSaveDialog({ title: '下载资产文件（选择新路径）', defaultPath: asset.currentFileName ?? asset.name }) as { canceled: boolean; filePath?: string }
      if (path.canceled || !path.filePath) return null
      return assetsApi.saveFile({ ...context, assetId: asset.id, ...(versionId === undefined ? {} : { versionId }), destinationPath: path.filePath })
    })
    if (result) setNotice('文件已保存。')
  }
  async function rollback(versionId: number) {
    const asset = data.selected; if (!asset) return
    const result = await data.write(context => assetsApi.rollbackVersion({ ...context, assetId: asset.id, expectedRevision: asset.revision, expectedCurrentVersionId: asset.currentVersionId, versionId }))
    data.accept(result.asset); setModal(null); setNotice('已以所选历史新增版本。'); void data.refresh()
  }
  async function remove(revision: number) {
    const asset = data.selected; if (!asset) return
    const result = await data.write(context => assetsApi.delete({ ...context, assetId: asset.id, expectedRevision: revision, confirm: true }))
    data.accept(null); setModal(null); setNotice(result.cleanupPending ? '资产已删除；部分文件清理待处理，详情见运行日志。' : '资产及历史已永久删除。'); void data.refresh()
  }
  async function openLink() {
    const url = data.selected?.externalUrl
    if (url) await data.write(async () => { if (!await window.electronAPI!.openExternal(url)) throw new Error('外链无法打开，请检查地址。') })
  }
  async function copy() {
    const asset = data.selected; if (!asset) return
    await data.write(async () => { await navigator.clipboard.writeText(asset.storageType === 'external_link' ? asset.externalUrl ?? '' : asset.currentContent) })
    setNotice('已复制。')
  }
  return <div className="flex h-full min-h-0 flex-col gap-3 p-4">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="module-title flex items-center gap-2 text-lg font-medium"><Boxes className="h-5 w-5" />资产库</h1><div className="flex gap-2"><Button size="sm" variant="outline" disabled={data.busy || data.loading} onClick={() => void requestAssetsLeave().then(ok => { if (ok) void refreshAll() })}><RefreshCw className="mr-1 h-4 w-4" />刷新</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => void open({ kind: 'tags' })}>标签管理</Button><Button size="sm" disabled={disabled} onClick={() => void open({ kind: 'edit' })}>新建资产</Button></div></header>
    <p className="text-xs text-muted-foreground">科研空间：{data.scope?.workspaceId ?? '正在读取…'}</p>
    <AssetError message={data.error} />{notice && <p role="status" className="text-sm">{notice}</p>}
    {data.error && <Button variant="outline" size="sm" className="self-start" disabled={data.busy} onClick={() => void data.refresh()}>重试读取</Button>}
    <div className="flex flex-wrap gap-2"><select aria-label="归档范围" className={controlClass + ' w-auto'} disabled={disabled} value={data.query.archived} onChange={e => void filter({ archived: e.target.value as AssetListQuery['archived'] })}><option value="exclude">未归档</option><option value="only">已归档</option><option value="include">含归档</option></select><select aria-label="形态筛选" className={controlClass + ' w-auto'} disabled={disabled} value={data.query.storageType ?? ''} onChange={e => void filter({ storageType: e.target.value ? e.target.value as AssetListQuery['storageType'] : undefined })}><option value="">全部形态</option><option value="inline_text">文本</option><option value="file">文件</option><option value="external_link">外链</option></select><select aria-label="标签匹配方式" className={controlClass + ' w-auto'} disabled={disabled} value={data.query.tagMode ?? 'and'} onChange={e => void filter({ tagMode: e.target.value as 'and' | 'or' })}><option value="and">全部标签匹配</option><option value="or">任一标签匹配</option></select><Button variant="outline" size="sm" disabled={disabled} onClick={() => void filter({ category: undefined, storageType: undefined, tagIds: [], tagMode: 'and', archived: 'exclude' })}>清空筛选</Button></div>
    <div className="flex flex-wrap gap-2">{data.tags.map(t => <label key={t.id} className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={disabled} checked={data.query.tagIds?.includes(t.id) ?? false} onChange={e => void filter({ tagIds: e.target.checked ? [...(data.query.tagIds ?? []), t.id] : data.query.tagIds?.filter(id => id !== t.id) })} />{t.name}</label>)}</div>
    {data.loading && <p role="status" className="text-sm text-muted-foreground">正在读取资产…</p>}
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:grid lg:grid-cols-[190px_280px_minmax(0,1fr)]">
      <aside className={data.selected ? 'hidden overflow-auto lg:block' : 'max-h-56 shrink-0 overflow-auto lg:max-h-none'}><details open className="lg:contents"><summary className="cursor-pointer text-sm lg:hidden">分类（选择后包含子树）</summary><CategoryTree categories={data.categories} current={data.query.category} disabled={disabled} onSelect={code => void filter({ category: code })} onEdit={category => void open({ kind: 'category', category })} /></details></aside>
      <div className={'min-h-64 flex-1 lg:min-h-0 ' + (data.selected ? 'hidden lg:block' : '')}><AssetList page={data.page} selectedId={data.selected?.id} disabled={disabled || data.loading} onSelect={id => void requestAssetsLeave().then(ok => { if (ok) void data.select(id) })} onPage={page => void filter({ page })} onCreate={() => void open({ kind: 'edit' })} /></div>
      <section className="min-h-0 min-w-0 overflow-auto">{data.detailLoading ? <p role="status">正在读取详情…</p> : data.selected ? <AssetDetail asset={data.selected} disabled={disabled} onEdit={() => void open({ kind: 'edit', asset: data.selected! })} onHistory={() => void open({ kind: 'history' })} onArchive={() => void perform(archive)} onDelete={() => void open({ kind: 'delete' })} onImport={() => void perform(importFile)} onDownload={() => void perform(() => download())} onCopy={() => void perform(copy)} onOpenLink={() => void perform(openLink)} onBack={() => void data.select(null)} /> : <p className="p-4 text-sm text-muted-foreground">选择资产查看详情，或新建资产。</p>}</section>
    </main>
    {modal?.kind === 'edit' && <AssetEditor asset={modal.asset} categories={data.categories} defaultCategory={data.query.category} onSave={save} onClose={() => setModal(null)} />}
    {modal?.kind === 'category' && data.scope && <CategoryEditor category={modal.category} categories={data.categories} scope={data.scope} write={data.write} onChanged={() => void refreshAll()} onClose={() => setModal(null)} />}
    {modal?.kind === 'tags' && data.scope && <TagManager tags={data.tags} scope={data.scope} write={data.write} onChanged={() => void refreshAll()} onClose={() => setModal(null)} />}
    {modal?.kind === 'history' && data.scope && data.selected && <VersionHistory asset={data.selected} scope={data.scope} onRollback={rollback} onDownload={download} onClose={() => setModal(null)} />}
    {modal?.kind === 'delete' && data.scope && data.selected && <DeleteAssetDialog asset={data.selected} scope={data.scope} onDelete={remove} onClose={() => setModal(null)} />}
  </div>
}
