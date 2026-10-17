import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { registerEvidenceEditor } from '@/lib/evidenceEditGuard'
import { libraryEvidenceApi } from '@/lib/libraryEvidenceApi'
import type { EvidenceExportReply, EvidenceExportRequest, EvidenceFilter, EvidenceScope } from '../../../../../shared/libraryEvidenceContracts'
import { evidenceControl } from './EvidenceEditor'

export function EvidenceExportDialog({ scope, revision, filter, onClose }: { scope: EvidenceScope; revision: number; filter: EvidenceFilter; onClose(): void }) {
  const [format, setFormat] = useState<EvidenceExportRequest['format']>('json'), [preview, setPreview] = useState<EvidenceExportReply>(), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const busyRef = useRef(false), active = useRef(true), filterKey = JSON.stringify(filter)
  useEffect(() => { active.current = true; const remove = registerEvidenceEditor({ isDirty: () => false, isBusy: () => busyRef.current, save: async () => !busyRef.current, discard: () => {} }); return () => { active.current = false; remove() } }, [])
  useEffect(() => {
    let current = true; setPreview(undefined); setError(''); setMessage('')
    void libraryEvidenceApi().export({ scope, expectedRevision: revision, filter, format, mode: 'preview', includeHistory: format === 'json' }).then(reply => {
      if (!current) return
      if (reply.ok) setPreview(reply)
      else setError(`${reply.code}：${reply.message}。请关闭本窗口并刷新矩阵后重试。`)
    }).catch(() => { if (current) setError('导出预览失败，请刷新矩阵后重试') })
    return () => { current = false }
  }, [scope.workspaceId, scope.spaceEpoch, revision, filterKey, format])
  async function save() {
    if (!preview || busyRef.current || preview.saved) return
    busyRef.current = true; setBusy(true); setError('')
    try {
      const reply = await libraryEvidenceApi().export({ scope, expectedRevision: revision, filter, format, mode: 'save', includeHistory: format === 'json', previewToken: preview.previewToken })
      if (!active.current) return
      if (!reply.ok) setError(`${reply.code}：${reply.message}。输入与原证据未改变。`)
      else { setPreview(reply); setMessage(reply.canceled ? '已取消，未写入导出文件' : `已保存新文件：${reply.fileName ?? ''}`) }
    } catch { if (active.current) setError('导出未完成，原证据保留，请重试') }
    finally { busyRef.current = false; if (active.current) setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busyRef.current) onClose() }}><DialogContent onEscapeKeyDown={e => { if (busyRef.current) e.preventDefault() }}>
    <DialogHeader><DialogTitle>导出文献证据</DialogTitle><DialogDescription>导出整个筛选范围，不受当前页限制；仅保存到原生窗口选择的新文件，不覆盖已有文件。</DialogDescription></DialogHeader>
    <p className="text-xs break-words">范围：{filter.projectId ? `项目 ${filter.projectId}` : '全部文献'} · {filter.archive === 'exclude' ? '非归档' : filter.archive === 'only' ? '仅归档' : '含归档'} · {filter.reviewState === 'checked' ? '用户已核对' : filter.reviewState === 'draft' ? '草稿' : '包含草稿'} · {filter.source === 'problem' ? '已知来源异常' : '全部来源'}{filter.keyword ? ` · 关键词：${filter.keyword}` : ''}</p>
    <label className="text-sm">导出格式<select aria-label="导出格式" className={evidenceControl} disabled={busy} value={format} onChange={e => setFormat(e.target.value as EvidenceExportRequest['format'])}><option value="json">JSON（全部历史，无损字段）</option><option value="markdown">Markdown（当前版本）</option><option value="csv">CSV（当前版本，公式安全处理）</option></select></label>
    <p className="text-xs text-muted-foreground">{format === 'json' ? 'JSON固定包含选中卡片的全部历史；首版不提供导入覆盖。' : '每张证据单独一行或一节；只导出当前版本。'}</p>
    <p role="status">{preview ? `${preview.cardCount} 张证据卡 · ${preview.versionCount} 个修订（完整筛选范围）` : '正在预览导出范围…'}</p>
    {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}{message && <p role="status" className="text-sm break-words">{message}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy || !preview || preview.saved} onClick={() => void save()}>{busy ? '正在保存…' : '选择新文件并导出'}</Button></div>
  </DialogContent></Dialog>
}
