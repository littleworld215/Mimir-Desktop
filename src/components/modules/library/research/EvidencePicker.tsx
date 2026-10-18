import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { libraryResearchApi } from '@/lib/libraryResearchApi'
import type { ResearchEvidenceRow, ResearchScope } from '../../../../../shared/libraryResearchContracts'
import type { EvidenceRelation } from '../../../../../shared/libraryEvidenceContracts'
import { researchControl, researchMessage, useResearchBusy } from './useResearchForm'

interface Props { scope: ResearchScope; projectId: string; questionId?: string; initialIds: string[]; excludedIds?: string[]; onApply(ids: string[], evidenceRevision: number): void; onClose(): void }
export function EvidencePicker({ scope, projectId, questionId, initialIds, excludedIds = [], onApply, onClose }: Props) {
  const [chosen, setChosen] = useState(() => new Set(initialIds)), [rows, setRows] = useState<ResearchEvidenceRow[]>([]), [page, setPage] = useState(1), [total, setTotal] = useState(0)
  const [keyword, setKeyword] = useState(''), [relation, setRelation] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState<number | null>(null), [retry, setRetry] = useState(0)
  const generation = useRef(0)
  // 应用/取消选择后才交给外层保存，防止先保存父表单再丢失未应用选择。
  useResearchBusy(true)
  useEffect(() => {
    const token = ++generation.current; setLoading(true); setError('')
    const timer = setTimeout(() => { void (async () => {
      try {
        const api = libraryResearchApi(), query = { scope, page, keyword, ...(relation ? { relation: relation as EvidenceRelation } : {}) }
        const reply = questionId ? await api.questionDetail({ ...query, questionId }) : await api.listEvidence({ ...query, projectId })
        if (generation.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        setRows('rows' in reply ? reply.rows : reply.items); setTotal(reply.total); setRevision(reply.evidenceRevision)
      } catch (failure) { if (generation.current === token) setError(researchMessage(failure)) }
      finally { if (generation.current === token) setLoading(false) }
    })() }, 150)
    return () => { clearTimeout(timer); generation.current++ }
  }, [scope.workspaceId, scope.spaceEpoch, projectId, questionId, page, keyword, relation, retry])
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>选择已有证据</DialogTitle><DialogDescription>跨页保留选择；请先应用或取消再离开页面。应用只更新表单，保存后才写入资料。</DialogDescription></DialogHeader>
    <div className="flex flex-wrap gap-2"><label className="flex-1 text-xs">证据关键词<input aria-label="证据关键词" className={researchControl} value={keyword} onChange={e => { setPage(1); setKeyword(e.target.value) }} /></label><label className="text-xs">人工关系<select aria-label="筛选人工关系" className={researchControl} value={relation} onChange={e => { setPage(1); setRelation(e.target.value) }}><option value="">全部判断</option><option value="supports">支持</option><option value="opposes">反对</option><option value="mixed">混合</option><option value="unassessed">未判断</option></select></label></div>
    {loading && <p role="status">正在读取证据…</p>}{error && <p role="alert" className="text-destructive">{error}<Button variant="outline" onClick={() => setRetry(v => v + 1)}>重试</Button></p>}
    {!loading && rows.map(row => <label key={row.cardId} className="flex items-start gap-2 rounded border border-border p-2 text-sm"><input type="checkbox" aria-label={`选择证据 ${row.cardId}`} checked={chosen.has(row.cardId)} disabled={excludedIds.includes(row.cardId) || row.version === null} onChange={e => { const next = new Set(chosen); if (e.target.checked) { if (next.size >= 500) { setError('最多选择500张卡，现有选择保留'); return }; next.add(row.cardId) } else next.delete(row.cardId); setChosen(next) }} /><span className="min-w-0 whitespace-pre-wrap break-words">{row.paperTitle ?? row.cardId} · v{row.version ?? '不可读'}<br />{row.quote || row.claim || row.question}<br /><span className="text-xs text-muted-foreground">{excludedIds.includes(row.cardId) ? '已在素材包中' : row.problems.join('；') || '草稿与未绑定来源可选，保存时再次复核'}</span></span></label>)}
    {!loading && !error && !rows.length && <p>暂无匹配证据，可调整筛选。</p>}
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage(v => v - 1)}>上一页</Button><span className="text-xs">第{page}页 · {total}张卡 · 已选{chosen.size}张</span><Button variant="outline" disabled={loading || page * 50 >= total} onClick={() => setPage(v => v + 1)}>下一页</Button></div>
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>取消选择</Button><Button disabled={loading || Boolean(error) || revision === null} onClick={() => { if (revision !== null) onApply([...chosen], revision) }}>应用选择</Button></div>
  </DialogContent></Dialog>
}
