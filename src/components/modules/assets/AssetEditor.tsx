import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetCategory, AssetCreateInput, AssetDetail, AssetKind, AssetPatch, StorageType } from '../../../../shared/assetsContracts'
import { requestAssetsLeave } from '@/lib/assetsEditGuard'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'

interface Props {
  asset?: AssetDetail
  categories: AssetCategory[]
  defaultCategory?: string
  onSave: (input: AssetCreateInput | AssetPatch) => Promise<void>
  onClose: () => void
}
export function AssetEditor({ asset, categories, defaultCategory, onSave, onClose }: Props) {
  const initial = useRef({ name: asset?.name ?? '', category: asset?.category ?? defaultCategory ?? 'inbox', storageType: asset?.storageType ?? 'inline_text' as StorageType,
    description: asset?.description ?? '', content: asset?.currentContent ?? '', externalUrl: asset?.externalUrl ?? '', notes: asset?.notes ?? '', sourceTask: asset?.sourceTask ?? '',
    kind: asset?.kind ?? '', tagNames: asset?.tags.map(t => t.name).join(', ') ?? '', source: asset?.sourceJson ?? '{}', templateConfig: JSON.stringify(asset?.templateConfig ?? { version: 1, variables: {} }, null, 2), changelog: '' })
  const [form, setForm] = useState(initial.current), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial.current)
  async function save(): Promise<boolean> {
    if (saving.current) return false
    saving.current = true; setBusy(true); setError('')
    try {
      const input: AssetCreateInput = { name: form.name, category: form.category, storageType: form.storageType, description: form.description, notes: form.notes, sourceTask: form.sourceTask,
        kind: form.kind === '' ? null : form.kind as AssetKind, tagNames: form.tagNames.split(/[,，]/).map(t => t.trim()).filter(Boolean), source: JSON.parse(form.source), templateConfig: JSON.parse(form.templateConfig), changelog: form.changelog }
      if (form.storageType === 'inline_text') input.content = form.content
      if (form.storageType === 'external_link') input.externalUrl = form.externalUrl
      if (asset) { const { storageType: _type, ...patch } = input; await onSave(patch) } else await onSave(input)
      return true
    } catch (error) { setError(`${errorMessage(error)}\n输入已保留；发生冲突时请取消并重新打开，或先复制当前输入。`); return false }
    finally { saving.current = false; setBusy(false) }
  }
  useAssetsEditorGuard({ isDirty: () => dirty, isBusy: () => saving.current, save, discard: onClose })
  const change = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }))
  return <AssetModal title={asset ? '编辑资产' : '新建资产'} onClose={() => { if (!saving.current) void requestAssetsLeave().then(ok => { if (ok) onClose() }) }}>
    <form onSubmit={event => { event.preventDefault(); void save() }} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2"><AssetField label="名称"><input className={controlClass} value={form.name} onChange={e => change('name', e.target.value)} required maxLength={200} /></AssetField>
          <AssetField label="分类"><select className={controlClass} value={form.category} onChange={e => change('category', e.target.value)}>{categories.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select></AssetField>
          <AssetField label="存储形态"><select className={controlClass} value={form.storageType} disabled={Boolean(asset)} onChange={e => change('storageType', e.target.value)}><option value="inline_text">文本</option><option value="file">文件</option><option value="external_link">外链</option></select></AssetField>
          <AssetField label="条目类型"><select className={controlClass} value={form.kind} onChange={e => change('kind', e.target.value)}><option value="">普通</option><option value="thought">思路</option><option value="rule">规则</option><option value="file">文件</option><option value="prompt">Prompt</option></select></AssetField></div>
        <AssetField label="摘要"><textarea className={controlClass} value={form.description} onChange={e => change('description', e.target.value)} /></AssetField>
        {form.storageType === 'inline_text' && <AssetField label="正文"><textarea className={`${controlClass} min-h-56 font-mono`} value={form.content} onChange={e => change('content', e.target.value)} /></AssetField>}
        {form.storageType === 'external_link' && <AssetField label="外链地址"><input className={controlClass} value={form.externalUrl} type="url" required onChange={e => change('externalUrl', e.target.value)} /></AssetField>}
        {form.storageType === 'file' && <p className="text-sm text-muted-foreground">保存后在详情中导入文件；再次导入会新增版本。</p>}
        <AssetField label="标签（逗号分隔）"><input className={controlClass} value={form.tagNames} onChange={e => change('tagNames', e.target.value)} /></AssetField>
        <AssetField label="来源任务"><input className={controlClass} value={form.sourceTask} onChange={e => change('sourceTask', e.target.value)} /></AssetField>
        <AssetField label="备注"><textarea className={controlClass} value={form.notes} onChange={e => change('notes', e.target.value)} /></AssetField>
        <AssetField label="本次变更说明"><input className={controlClass} value={form.changelog} onChange={e => change('changelog', e.target.value)} /></AssetField>
        <details><summary className="cursor-pointer text-sm">来源与变量配置（JSON）</summary><div className="mt-3 space-y-3"><AssetField label="来源 JSON"><textarea className={`${controlClass} font-mono`} value={form.source} onChange={e => change('source', e.target.value)} /></AssetField><AssetField label="变量配置 JSON"><textarea className={`${controlClass} min-h-32 font-mono`} value={form.templateConfig} onChange={e => change('templateConfig', e.target.value)} /></AssetField></div></details>
      </fieldset>
      <AssetError message={error} />
      <div className="flex items-center justify-between"><span role="status" className="text-xs text-muted-foreground">{busy ? '正在保存…' : dirty ? '有未保存修改' : '未修改'}</span><div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => void requestAssetsLeave().then(ok => { if (ok) onClose() })}>取消</Button><Button disabled={busy} type="submit">{busy ? '保存中…' : '保存'}</Button></div></div>
    </form>
  </AssetModal>
}
