import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { DraftSummary, EditingDraft, EditingFields, EditingScope, EditingStatus } from '../../../../shared/libraryEditingContracts'
export const editingKindLabel = { notes: '自由笔记', tags: '标签', append: '阅读器追加' }
const statusLabel = { editable: '待选择恢复', conflict: '正式内容已变化，请对照复制', 'already-saved': '文献已保存，可清理残留草稿', missing: '文献已失联，仅查看复制', trashed: '文献在回收站，仅查看复制' }
export function PaperDraftRecovery({ draft, status, current, onRestore, onDiscard }: { draft: EditingDraft; status: EditingStatus; current: EditingFields; onRestore(d: EditingDraft): void | Promise<void>; onDiscard(d: EditingDraft): void | Promise<void> }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  async function action(fn: () => void | Promise<void>) { if (busy) return; setBusy(true); setMessage(''); try { await fn() } catch (e) { setMessage(e instanceof Error ? e.message : '操作未完成') } finally { setBusy(false) } }
  const text = (fields: EditingFields) => fields.notes ?? fields.tags?.join(', ') ?? '（文献不可用）'
  return <section aria-label="草稿对照" className="space-y-2 rounded border border-border bg-card p-3 text-xs">
    <p>{editingKindLabel[draft.kind]} · {statusLabel[status]}</p>
    <div className="grid gap-2 sm:grid-cols-3">{[['原始基线', text(draft.base)], ['当前文献', text(current)], ['恢复草稿输入', draft.input]].map(([label, value]) => <div key={label}><p className="mb-1 text-muted-foreground">{label}</p><pre aria-label={label} tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-sans focus-visible:ring-2 focus-visible:ring-ring">{value}</pre></div>)}</div>
    <div className="flex flex-wrap gap-2">
      {status === 'editable' && <Button size="sm" disabled={busy} onClick={() => void action(() => onRestore(draft))}>恢复到编辑器</Button>}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void action(async () => { await navigator.clipboard.writeText(draft.input); setMessage('已复制原始输入') })}>复制草稿输入</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void action(() => onDiscard(draft))}>明确丢弃此草稿</Button>
    </div>
    {message && <p role="status" className="whitespace-pre-wrap">{message}</p>}
  </section>
}
export function PaperDraftChoices({ scope, existing, current, onRestore, onDiscard }: { scope: EditingScope; existing: DraftSummary[]; current: EditingFields; onRestore(d: EditingDraft): Promise<void>; onDiscard(d: EditingDraft): Promise<void> }) {
  const [detail, setDetail] = useState<{ draft: EditingDraft; status: EditingStatus }>(), [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => { ++generation.current; setDetail(undefined); return () => { ++generation.current } }, [scope.workspaceId, scope.spaceEpoch])
  async function inspect(id: string) { const g = ++generation.current; setError(''); try { const r = await window.electronAPI!.libraryEditing.detail({ scope, id }); if (g !== generation.current) return; if (!r.ok) throw Error(r.message); setDetail(r) } catch (e) { if (g === generation.current) setError(e instanceof Error ? e.message : '读取失败') } }
  return <div className="space-y-2"><p className="text-xs">发现已有恢复草稿。选择恢复或明确丢弃前，不自动覆盖，也不会写入正式文献。</p>
    {existing.map(d => <Button size="sm" variant="outline" key={d.id} onClick={() => void inspect(d.id)}>{editingKindLabel[d.kind]} · {d.updatedAt} · 查看对照</Button>)}
    {detail && existing.some(d => d.id === detail.draft.id) && <PaperDraftRecovery key={detail.draft.id} {...detail} current={current} onRestore={onRestore} onDiscard={onDiscard} />}
    {error && <p role="alert">{error}</p>}
  </div>
}
