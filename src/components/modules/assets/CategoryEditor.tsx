import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAssetPreview } from './useAssetPreview'
import { requestAssetsLeave } from '@/lib/assetsEditGuard'
import type { AssetCategory, CategoryImpact, StorageType, WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
export function CategoryEditor({ category, categories, scope, write, onChanged, onClose }: { category?: AssetCategory; categories: AssetCategory[]; scope: WorkspaceRequest; write: <T>(operation: (scope: WorkspaceRequest) => Promise<T>) => Promise<T>; onChanged: () => void; onClose: () => void }) {
  const initial = useRef({ code: category?.code ?? '', name: category?.name ?? '', parentCode: category?.parentCode ?? '', icon: category?.icon ?? '', description: category?.description ?? '', defaultStorageType: category?.defaultStorageType ?? '', sortOrder: String(category?.sortOrder ?? 0) })
  const [form, setForm] = useState(initial.current), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false)
  const preview = useAssetPreview<CategoryImpact>(), impact = preview.value
  const running = useRef(false), dirty = JSON.stringify(form) !== JSON.stringify(initial.current)
  const change = (key: keyof typeof form, value: string) => { setForm(f => ({ ...f, [key]: value })); preview.clear(); setConfirmed(false) }
  async function save(): Promise<boolean> { if (running.current) return false; running.current = true; setBusy(true); setError('')
    try { const input = { name: form.name, parentCode: form.parentCode || null, icon: form.icon || null, description: form.description, defaultStorageType: (form.defaultStorageType || null) as StorageType | null, sortOrder: Number(form.sortOrder) }
      await write(context => category ? assetsApi.updateCategory({ ...context, code: category.code, expectedRevision: category.revision, patch: input }) : assetsApi.createCategory({ ...context, input: { ...input, ...(form.code ? { code: form.code } : {}) } }))
      onChanged(); onClose(); return true
    } catch (error) { setError(errorMessage(error)); return false } finally { running.current = false; setBusy(false) }
  }
  useAssetsEditorGuard({ isDirty: () => dirty, isBusy: () => running.current, save, discard: onClose })
  async function remove() { if (!category || !confirmed || !impact || impact.code !== category.code || preview.loading || running.current) return; running.current = true; setBusy(true)
    try { await write(context => assetsApi.deleteCategory({ ...context, code: category.code, expectedRevision: category.revision, confirm: true })); onChanged(); onClose() }
    catch (error) { setError(errorMessage(error)); preview.clear(); setConfirmed(false) } finally { running.current = false; setBusy(false) }
  }
  return <AssetModal title={category ? '编辑分类' : '新建分类'} onClose={() => { if (!running.current) void requestAssetsLeave().then(ok => { if (ok) onClose() }) }}>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2"><AssetField label="分类名称"><input className={controlClass} value={form.name} required onChange={e => change('name', e.target.value)} /></AssetField><AssetField label="分类编码"><input className={controlClass} value={form.code} disabled={Boolean(category)} placeholder="留空自动生成" onChange={e => change('code', e.target.value)} /></AssetField><AssetField label="父分类"><select className={controlClass} value={form.parentCode} onChange={e => change('parentCode', e.target.value)}><option value="">顶级分类</option>{categories.filter(c => c.code !== category?.code).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select></AssetField><AssetField label="默认形态"><select className={controlClass} value={form.defaultStorageType} onChange={e => change('defaultStorageType', e.target.value)}><option value="">不指定</option><option value="inline_text">文本</option><option value="file">文件</option><option value="external_link">外链</option></select></AssetField><AssetField label="排序"><input className={controlClass} type="number" step="1" value={form.sortOrder} onChange={e => change('sortOrder', e.target.value)} /></AssetField><AssetField label="图标标识"><input className={controlClass} value={form.icon} onChange={e => change('icon', e.target.value)} /></AssetField><AssetField label="说明"><textarea className={controlClass} value={form.description} onChange={e => change('description', e.target.value)} /></AssetField></fieldset><AssetError message={error || preview.error} /><Button disabled={busy} type="submit">{busy ? '保存中…' : '保存分类'}</Button></form>
    {category && <section className="space-y-2 border-t border-border pt-3"><Button variant="outline" disabled={busy || preview.loading || dirty || category.builtin} onClick={() => { setConfirmed(false); void preview.read(async () => (await assetsApi.categoryImpact({ ...scope, code: category.code })).impact) }}>读取分类删除影响</Button>{category.builtin && <p className="text-xs">内置分类不能删除。</p>}{impact && <><p className="text-sm">包含归档与子树：{impact.assetCount} 条资产、{impact.childCount} 个子分类。</p><label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy || impact.assetCount > 0 || impact.childCount > 0 || impact.builtin} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认删除空分类</label><Button variant="destructive" disabled={busy || !confirmed} onClick={() => void remove()}>删除分类</Button></>}</section>}
  </AssetModal>
}
