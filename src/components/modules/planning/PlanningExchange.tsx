import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { researchControl, useResearchBusy } from '../library/research/useResearchForm'
import { PLANNING_KIND_LABELS } from '../../../../shared/researchPlanningDefaults'
import type { PlanningCollection, PlanningExportFormat, PlanningExportPreview, PlanningImportOptions, PlanningImportPreview, PlanningImportSelection, PlanningScope } from '../../../../shared/researchPlanningContracts'

export function PlanningExchange({ scope, revision: initialRevision, collections, onClose, onApplied }: { scope: PlanningScope; revision: number; collections: PlanningCollection[]; onClose(): void; onApplied(message: string): void }) {
  const [revision, setRevision] = useState(initialRevision), [selection, setSelection] = useState<PlanningImportSelection | null>(null), [options, setOptions] = useState<PlanningImportOptions>({ strategy: 'skip', collections: {} }), [preview, setPreview] = useState<PlanningImportPreview | null>(null)
  const [format, setFormat] = useState<PlanningExportFormat>('json'), [exported, setExported] = useState<PlanningExportPreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const active = useRef(true), working = useRef(false), errorRef = useRef<HTMLParagraphElement>(null)
  useResearchBusy(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { if (error && !busy) errorRef.current?.focus() }, [error, busy])
  async function run(action: () => Promise<void>) {
    if (working.current || !active.current) return
    working.current = true; setBusy(true); setError(''); setNotice('')
    try { await action() } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : '操作未完成，选择保留') }
    finally { working.current = false; if (active.current) setBusy(false) }
  }
  const api = () => { const value = window.electronAPI?.researchPlanning; if (!value) throw Error('科研计划接口不可用'); return value }
  async function select() {
    setSelection(null); setPreview(null); setOptions({ strategy: 'skip', collections: {} })
    const result = await api().selectImport({ scope })
    if (!result.ok) throw Error(result.message)
    if (active.current) { setSelection(result.selection); if (result.canceled) setNotice('已取消选择，未导入任何内容。') }
  }
  async function inspect() {
    if (!selection) return
    setPreview(null)
    const result = await api().previewImport({ scope, expectedRevision: revision, importId: selection.importId, options })
    if (!result.ok) throw Error(result.message)
    if (active.current) setPreview(result)
  }
  async function apply() {
    if (!selection || !preview) return
    const result = await api().applyImport({ scope, expectedRevision: preview.revision, importId: selection.importId, previewToken: preview.previewToken })
    if (!result.ok) { setPreview(null); throw Error(result.message) }
    if (active.current) onApplied(`导入完成：新增${result.counts.added}、副本${result.counts.copied}、更新${result.counts.updated}、跳过${result.counts.skipped}。`)
  }
  async function inspectExport() {
    setExported(null)
    const result = await api().exportPreview({ scope, expectedRevision: revision, format })
    if (!result.ok) throw Error(result.message)
    if (active.current) setExported(result)
  }
  async function saveExport() {
    if (!exported) return
    const result = await api().saveExport({ scope, expectedRevision: exported.revision, previewToken: exported.previewToken })
    if (!result.ok) throw Error(result.message)
    if (active.current) { setNotice(result.saved ? `已保存新文件：${result.fileName}` : '已取消保存，预览保留。'); if (result.saved) setExported(null) }
  }
  async function refreshRevision() {
    const result = await api().bootstrap({})
    if (!result.ok) throw Error(result.message)
    if (result.scope.workspaceId !== scope.workspaceId || result.scope.spaceEpoch !== scope.spaceEpoch) throw Error('科研空间已变化，请关闭窗口；当前选择不会写入其他空间。')
    if (active.current) { setRevision(result.revision); setPreview(null); setExported(null); setNotice('已核对当前版本，请重新预览差异。') }
  }
  return <Dialog open onOpenChange={open => { if (!open && !working.current) onClose() }}><DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto" onEscapeKeyDown={e => { if (working.current) e.preventDefault() }} onPointerDownOutside={e => { if (working.current) e.preventDefault() }}><DialogHeader><DialogTitle>科研计划导入与导出</DialogTitle><DialogDescription>只处理当前空间的科研计划业务；先预览再提交，不替换整库。导出包含全部分组、归档和回收站。</DialogDescription></DialogHeader>
    {error && <p role="alert" ref={errorRef} tabIndex={-1} className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <section className="space-y-3 rounded border border-border p-3" aria-label="导入科研计划"><h3 className="font-medium">导入JSON</h3><p className="text-xs text-muted-foreground">支持Research-Workbench v1/v2和本项目业务JSON；不导入示例、外部设置或模型配置。</p><Button type="button" variant="outline" disabled={busy} onClick={() => { void run(select) }}>选择JSON并读取预览信息</Button>
      {selection && <><p className="break-words text-sm">{selection.fileName}</p><p className="break-words text-xs text-muted-foreground">{selection.format} · {selection.itemCount}条 · {selection.typeCount}种类型 · {selection.brokenReferenceCount}个失联关联 · {selection.bytes}字节 · SHA256 {selection.sha256}</p><label className="block text-sm">重复项策略<select aria-label="重复项策略" className={researchControl} value={options.strategy} disabled={busy} onChange={e => { setOptions({ ...options, strategy: e.target.value as PlanningImportOptions['strategy'] }); setPreview(null) }}><option value="skip">跳过重复（默认）</option><option value="copy">重复项保留副本</option><option value="update">更新相同导入标识的记录</option></select></label>
        {selection.collections.map(group => <label className="block text-sm" key={group.id}>{group.name}（{group.count}条）<select aria-label={`映射分组${group.name}`} className={researchControl} disabled={busy} value={options.collections[group.id] ?? ''} onChange={e => { const next = { ...options.collections }; if (e.target.value) next[group.id] = e.target.value; else delete next[group.id]; setOptions({ ...options, collections: next }); setPreview(null) }}><option value="">保留导入分组（已有相同标识时复用）</option>{collections.filter(c => !c.deleted).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>)}
        {selection.warnings.length > 0 && <label className="block text-sm">转换与关联说明<textarea aria-label="转换与关联说明" readOnly rows={4} className={researchControl} value={selection.warnings.join('\n')} /></label>}
        <Button type="button" variant="outline" disabled={busy} onClick={() => { void run(inspect) }}>预览导入差异</Button>
        {preview && <div className="space-y-2 rounded bg-accent p-3 text-sm"><p>新增{preview.counts.added} · 副本{preview.counts.copied} · 更新{preview.counts.updated} · 跳过{preview.counts.skipped}；完成后共{preview.totalAfter}条（含回收站）</p><ImportDuplicates key={preview.previewToken} scope={scope} selection={selection} preview={preview} busy={busy} run={run} /><Button type="button" disabled={busy} onClick={() => { void run(apply) }}>确认按预览导入</Button></div>}
      </>}
    </section>
    <section className="space-y-3 rounded border border-border p-3" aria-label="导出科研计划"><h3 className="font-medium">导出全部科研计划</h3><p className="text-xs text-muted-foreground">JSON可完整交换业务记录；Markdown、CSV、HTML用于阅读展示。恢复草稿、提醒状态和资料文件请使用整空间备份。</p><select aria-label="导出格式" className={researchControl} disabled={busy} value={format} onChange={e => { setFormat(e.target.value as PlanningExportFormat); setExported(null) }}><option value="json">JSON完整业务</option><option value="markdown">Markdown</option><option value="csv">CSV</option><option value="html">HTML</option></select><Button type="button" variant="outline" disabled={busy} onClick={() => { void run(inspectExport) }}>生成导出预览</Button>
      {exported && <><p className="break-words text-xs">{exported.itemCount}条 · {exported.bytes}字节 · SHA256 {exported.sha256}</p><textarea aria-label="导出文件完整文本（只读）" readOnly rows={10} className={`${researchControl} font-mono`} value={exported.text} /><Button type="button" disabled={busy} onClick={() => { void run(saveExport) }}>选择位置并保存新文件</Button></>}
    </section><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => { void run(refreshRevision) }}>核对当前版本并重新预览</Button><Button type="button" variant="outline" disabled={busy} onClick={onClose}>关闭交换窗口</Button>{busy && <p role="status">操作进行中…</p>}</div>
  </DialogContent></Dialog>
}
function ImportDuplicates({ scope, selection, preview, busy, run }: { scope: PlanningScope; selection: PlanningImportSelection; preview: PlanningImportPreview; busy: boolean; run(action: () => Promise<void>): Promise<void> }) {
  const [page, setPage] = useState(1), [difference, setDifference] = useState<{ before: unknown; incoming: unknown } | null>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const duplicates = preview.duplicates ?? []
  if (!duplicates.length) return null
  async function inspect(itemId: string) {
    const api = window.electronAPI?.researchPlanning
    if (typeof api?.importDifference !== 'function') throw Error('完整差异接口不可用，请重新打开新版工作台')
    const result = await api.importDifference({ scope, expectedRevision: preview.revision, importId: selection.importId, previewToken: preview.previewToken, itemId })
    if (!result.ok) throw Error(result.message)
    if (active.current) setDifference(result)
  }
  return <section className="space-y-2 rounded border border-border bg-card p-2"><h4 className="font-medium">重复记录明细（{duplicates.length}条，每页50条）</h4>{duplicates.slice((page - 1) * 50, page * 50).map(row => <div key={row.id} className="space-y-1 border-b border-border py-2"><p className="break-words">当前：{row.before.title} · {PLANNING_KIND_LABELS[row.before.kind]} · {row.before.deleted ? '回收站' : '有效'} · {row.before.archived ? '已归档' : '未归档'}</p><p className="break-words">导入：{row.incoming.title} · {PLANNING_KIND_LABELS[row.incoming.kind]} · {row.incoming.deleted ? '回收站' : '有效'} · {row.incoming.archived ? '已归档' : '未归档'} · {row.bodyChanged ? '正文有变化' : '正文相同'}</p><Button type="button" variant="outline" size="sm" aria-label={`查看完整差异${row.incoming.title}`} disabled={busy} onClick={() => { void run(() => inspect(row.id)) }}>查看完整字段和正文</Button></div>)}<div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页重复项</Button><Button type="button" variant="outline" size="sm" disabled={busy || page * 50 >= duplicates.length} onClick={() => setPage(page + 1)}>下一页重复项</Button></div>
    {difference && <div className="space-y-2"><p className="text-xs text-muted-foreground">以下完整原始字段仅供核对；分组按上方映射，副本会使用新标识，跳过不会写入。</p><div className="grid gap-2 md:grid-cols-2"><label>当前记录完整字段<textarea aria-label="当前记录完整字段" readOnly rows={12} className={`${researchControl} font-mono`} value={JSON.stringify(difference.before, null, 2)} /></label><label>导入记录完整字段<textarea aria-label="导入记录完整字段" readOnly rows={12} className={`${researchControl} font-mono`} value={JSON.stringify(difference.incoming, null, 2)} /></label></div></div>}
  </section>
}
