import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PaperLifecyclePreview, PaperLifecycleScope, PaperTrashRow } from '../../../../shared/libraryLifecycle'

export interface PaperLifecycleRequest { scope: PaperLifecycleScope; arxivId: string; action: 'trash' | 'restore' }
export function PaperLifecycleDialog({ request, onClose, onApplied }: {
  request: PaperLifecycleRequest; onClose(): void; onApplied(request: PaperLifecycleRequest): void
}) {
  const [preview, setPreview] = useState<PaperLifecyclePreview | null>(null)
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const sequence = useRef(0), saving = useRef(false), alive = useRef(true)
  const load = useCallback(async () => {
    const generation = ++sequence.current
    setLoading(true); setError(''); setPreview(null)
    try {
      const result = await window.electronAPI!.library.previewPaperLifecycle(request)
      if (!alive.current || generation !== sequence.current) return
      if (!result.ok) setError(result.message)
      else setPreview(result.preview)
    } catch { if (alive.current && generation === sequence.current) setError('影响读取失败，请重试；原资料保留') }
    finally { if (alive.current && generation === sequence.current) setLoading(false) }
  }, [request])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; sequence.current++ } }, [load])
  async function apply() {
    if (!preview || saving.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      const result = await window.electronAPI!.library.applyPaperLifecycle({ scope: request.scope, token: preview.token })
      if (!alive.current) return
      if (!result.ok) setError(result.message)
      else onApplied(request)
    } catch { if (alive.current) setError('操作未完成，请保留窗口并重试') }
    finally { saving.current = false; if (alive.current) setBusy(false) }
  }
  const trash = request.action === 'trash'
  return <Dialog open onOpenChange={open => { if (!open && !saving.current) onClose() }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto" aria-busy={busy || loading}>
      <DialogHeader><DialogTitle>{trash ? '移入文献回收站' : '恢复文献'}</DialogTitle>
        <DialogDescription>{trash ? '保留原标识、笔记、标签、PDF和全部证据/素材历史。活动列表和新建关联将隐藏此文献，已有引用保留并提示来源不可用；恢复后重新关联。' : '恢复原文献及其原标识，不重写历史，不自动重新导入或新建项目。'}</DialogDescription></DialogHeader>
      {loading && <p role="status">正在读取关联影响…</p>}
      {preview && <div className="space-y-2 break-words text-sm">
        <p className="font-medium">{preview.title}</p>
        <p>关联项目：{preview.projectNames.join('、') || '无'}</p>
        <p>证据卡 {preview.counts.evidenceCards} 张（历史 {preview.counts.evidenceVersions} 版）；研究问题 {preview.counts.questions} 组；写作素材包 {preview.counts.packs} 个。</p>
        <p>科研计划 {preview.counts.planningItems} 条；计划恢复草稿 {preview.counts.planningDrafts} 条。包含归档及历史引用，均保留。</p>
        <p>文献编辑恢复草稿 {preview.counts.editingDrafts} 条，包含笔记、标签和阅读器追加；回收或恢复均保留原输入。</p>
        {preview.missingProjectIds.length > 0 && <p className="rounded border border-border p-2">原项目已失联：{preview.missingProjectIds.join('、')}。保留这些关联标识，恢复不会重建或替换项目。</p>}
      </div>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter className="flex-wrap gap-2">
        <Button variant="outline" disabled={busy || loading} onClick={() => void load()}>重新预览</Button>
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button disabled={busy || loading || !preview} onClick={() => void apply()}>{busy ? '处理中…' : trash ? '确认移入回收站' : '确认恢复'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function PaperTrashDialog({ onClose, onRestore }: { onClose(): void; onRestore(arxivId: string, scope: PaperLifecycleScope): void }) {
  const [rows, setRows] = useState<PaperTrashRow[]>([]), [scope, setScope] = useState<PaperLifecycleScope | null>(null)
  const [keyword, setKeyword] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const sequence = useRef(0), alive = useRef(true)
  const load = useCallback(async () => {
    const generation = ++sequence.current
    setLoading(true); setError(''); setScope(null)
    try {
      const result = await window.electronAPI!.library.paperTrash()
      if (!alive.current || generation !== sequence.current) return
      if (!result.ok) setError(result.message)
      else { setRows(result.papers); setScope(result.scope) }
    } catch { if (alive.current && generation === sequence.current) setError('回收站读取失败，请重试') }
    finally { if (alive.current && generation === sequence.current) setLoading(false) }
  }, [])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; sequence.current++ } }, [load])
  const term = keyword.normalize('NFKC').trim().toLocaleLowerCase()
  const visible = rows.filter(row => (row.title + '\n' + row.arxivId).normalize('NFKC').toLocaleLowerCase().includes(term))
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>文献回收站</DialogTitle><DialogDescription>只保存可恢复的移除状态；PDF、笔记与历史保留。本版不提供永久清空，重新导入不会自动恢复。</DialogDescription></DialogHeader>
      <Input aria-label="检索回收文献" placeholder="标题或标识" value={keyword} onChange={e => setKeyword(e.target.value)} />
      {loading ? <p role="status">正在读取回收站…</p> : error ? <p role="alert" className="text-destructive">{error}</p> :
        <div className="space-y-2">{visible.length === 0 && <p>没有匹配的回收文献</p>}{visible.map(row => <div key={row.arxivId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3">
          <div className="min-w-0 flex-1 break-words text-sm"><p className="font-medium">{row.title}</p>
            <p className="text-xs text-muted-foreground">{row.arxivId} · 移除：{row.removedAt.slice(0, 10)} · {row.hasPdf ? 'PDF路径保留' : '未登记PDF'} · {row.tagCount} 个标签</p></div>
          <Button variant="outline" disabled={!scope} aria-label={'恢复：' + row.title} onClick={() => scope && onRestore(row.arxivId, scope)}>恢复</Button>
        </div>)}</div>}
      <DialogFooter><Button variant="outline" disabled={loading} onClick={() => void load()}>刷新回收站</Button><Button onClick={onClose}>关闭</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
