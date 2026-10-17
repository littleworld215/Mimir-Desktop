import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { hasEvidenceWork, registerEvidenceEditor, requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import { initialEvidenceFilter, libraryEvidenceApi } from '@/lib/libraryEvidenceApi'
import type { EvidenceCard, EvidenceCardReply, EvidenceCardSummary, EvidenceScope, SourceInspection, SourceOpenResult } from '../../../../../shared/libraryEvidenceContracts'
import { EvidenceEditor } from './EvidenceEditor'
import { EvidenceHistory } from './EvidenceHistory'

export const evidenceSourceLabels = { unchecked: '本轮尚未检查', available: '上次检查匹配', unbound: '未绑定PDF', missing: 'PDF缺失', changed: '来源版本变化', detached: '来源文献已移除', unauthorized: '来源未授权或不是PDF' }
interface Props {
  paperId: string; projectId?: string; scope?: EvidenceScope
  papers?: { arxivId: string; title: string }[]; projects?: { id: string; title: string }[]
  onOpenSource(source: SourceOpenResult): void
  initialCardId?: string
}
export function EvidencePanel({ paperId, projectId, scope, papers, projects, onOpenSource, initialCardId }: Props) {
  const [cards, setCards] = useState<EvidenceCardSummary[]>([]), [selected, setSelected] = useState<EvidenceCard | null | undefined>()
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [archived, setArchived] = useState(false), [inspection, setInspection] = useState<SourceInspection>()
  const scopeRef = useRef<EvidenceScope>(), generation = useRef(0), busyRef = useRef(false), newButton = useRef<HTMLButtonElement>(null)
  const selectedRef = useRef(selected); selectedRef.current = selected
  useEffect(() => registerEvidenceEditor({ isDirty: () => false, isBusy: () => busyRef.current, save: async () => !busyRef.current, discard: () => {} }), [])
  async function load(token: number) {
    setLoading(true); setError(''); setSelected(undefined); setInspection(undefined)
    try {
      const api = libraryEvidenceApi()
      let accepted = scope
      if (!accepted) {
        const boot = await api.list({ filter: initialEvidenceFilter(), page: 1 })
        if (generation.current !== token) return
        if (!boot.ok) throw Error(boot.message)
        accepted = boot.scope
      }
      if (generation.current !== token) return
      scopeRef.current = accepted
      let page = 1
      // 仅按需翻页寻找当前文献；Task5的完整关键词筛选会进一步收窄结果。
      while (true) {
        const reply = await api.list({ scope: accepted, filter: { archive: 'include', source: 'all', keyword: paperId }, page })
        if (generation.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        const row = reply.rows.find(r => r.paperId === paperId)
        setRevision(reply.revision)
        if (row || page * 50 >= reply.total || page >= 100) { setCards(row?.cards ?? []); break }
        page += 1
      }
      if (initialCardId) await openCard(initialCardId, token)
    } catch (failure) { if (generation.current === token) setError(failure instanceof Error ? failure.message : '证据读取失败，请重试') }
    finally { if (generation.current === token) setLoading(false) }
  }
  useEffect(() => {
    const token = ++generation.current; scopeRef.current = undefined; setCards([]); busyRef.current = false; setBusy(false)
    void load(token)
    return () => { generation.current += 1 }
  }, [paperId, projectId, scope?.workspaceId, scope?.spaceEpoch, initialCardId])
  async function openCard(id: string, token = generation.current) {
    if (!scopeRef.current) return
    const found = await libraryEvidenceApi().detail({ scope: scopeRef.current, cardId: id })
    if (generation.current !== token) return
    if (!found.ok) { setError(found.message); return }
    setSelected(found.card); setRevision(found.revision); setInspection(undefined)
  }
  async function choose(id?: string) {
    if (!await requestEvidenceLeave()) return
    setError(''); setInspection(undefined)
    const token = ++generation.current
    if (id) { try { await openCard(id, token) } catch { if (generation.current === token) setError('证据详情读取失败，请重试') } }
    else setSelected(null)
  }
  function applied(reply: EvidenceCardReply) {
    setSelected(reply.card); setRevision(reply.revision); setInspection(undefined)
    const v = reply.card.versions[reply.card.currentVersion - 1]!
    const preview = (text: string) => Array.from(text).slice(0, 200).join('')
    setCards(previous => [...previous.filter(c => c.cardId !== reply.card.id), ...(v.paperId === paperId ? [{ cardId: reply.card.id, version: v.version, question: preview(v.question), method: preview(v.method), datasetOrMaterial: preview(v.datasetOrMaterial), finding: preview(v.finding), limitation: preview(v.limitation), locator: v.locator, relation: v.relation, reviewState: v.reviewState, archived: v.archived, sourceStatus: v.documentBinding ? 'unchecked' as const : 'unbound' as const }] : [])])
  }
  async function sourceAction(mode: 'inspect' | 'confirm' | 'open' | 'archive', version = selectedRef.current?.currentVersion) {
    const card = selectedRef.current, accepted = scopeRef.current, token = generation.current
    if (!card || !accepted || !version || busyRef.current) return
    if (hasEvidenceWork()) { setError('请先保存或取消编辑，再核对、打开来源或归档'); return }
    busyRef.current = true; setBusy(true); setError('')
    try {
      const api = libraryEvidenceApi()
      if (mode === 'open') {
        const reply = await api.openSource({ scope: accepted, cardId: card.id, version })
        if (generation.current !== token || selectedRef.current?.id !== card.id) return
        if (!reply.ok) throw Error(reply.message)
        setInspection({ status: reply.source.status, checkedAt: reply.source.checkedAt }); onOpenSource(reply.source)
      } else if (mode === 'archive') {
        const reply = await api.archive({ scope: accepted, cardId: card.id, expectedRevision: revision, archived: !card.versions[card.currentVersion - 1]!.archived })
        if (generation.current !== token || selectedRef.current?.id !== card.id) return
        if (!reply.ok) throw Error(reply.message)
        applied(reply)
      } else {
        const reply = await api.checkSource(mode === 'confirm' ? { scope: accepted, cardId: card.id, mode, expectedRevision: revision } : { scope: accepted, cardId: card.id, mode, version })
        if (generation.current !== token || selectedRef.current?.id !== card.id) return
        if (!reply.ok) throw Error(reply.message)
        if ('card' in reply) { applied(reply); setInspection({ status: 'available', checkedAt: reply.card.versions[reply.card.currentVersion - 1]?.documentBinding?.checkedAt }) }
        if ('inspection' in reply) setInspection(reply.inspection)
      }
    } catch (failure) { if (generation.current === token) setError(failure instanceof Error ? failure.message : '操作失败，请重试') }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false) } }
  }
  const current = selected?.versions[selected.currentVersion - 1]
  return <section aria-label="文献证据卡" className="min-w-0 text-foreground">
    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3"><Button ref={newButton} disabled={loading || busy || !scopeRef.current} onClick={() => void choose()}>新建证据卡</Button><Button variant="outline" disabled={busy} onClick={async () => { if (await requestEvidenceLeave()) await load(++generation.current) }}>重新加载</Button><label className="text-xs"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> 包含归档</label></div>
    {loading && <p role="status" className="p-3 text-sm text-muted-foreground">正在读取证据…</p>}
    {error && <p role="alert" className="p-3 text-sm text-destructive break-words">{error}</p>}
    {!loading && <div className="space-y-1 p-3">{cards.filter(c => archived || !c.archived).map(c => <Button className="h-auto w-full justify-start text-left whitespace-normal" variant="outline" key={c.cardId} onClick={() => void choose(c.cardId)}><span className="break-words">{c.question || '未填写研究问题'} · v{c.version} · {c.archived ? '已归档' : c.reviewState === 'checked' ? '用户已核对' : '草稿'} · {evidenceSourceLabels[c.sourceStatus]}</span></Button>)}{cards.length === 0 && <p className="text-xs text-muted-foreground">暂无证据卡。手动摘录原文，保留不同判断与来源；不会自动转换阅读笔记。</p>}</div>}
    {selected && <div className="space-y-2 border-t border-border p-3"><p className="text-xs break-words">{current?.paperSnapshot.title} · v{selected.currentVersion} · {current?.reviewState === 'checked' ? '用户已核对（不代表科研事实验证）' : '草稿'}{current?.archived ? ' · 已归档' : ''}</p><p className="text-xs text-muted-foreground">{evidenceSourceLabels[inspection?.status ?? (current?.documentBinding ? 'unchecked' : 'unbound')]}{inspection?.checkedAt ? ` · 上次检查 ${inspection.checkedAt}` : ''}</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void sourceAction('inspect')}>检查来源</Button><Button variant="outline" disabled={busy} onClick={() => void sourceAction('confirm')}>我已核对原文与页码</Button><Button variant="outline" disabled={busy} onClick={() => void sourceAction('open')}>打开原文</Button><Button variant="outline" disabled={busy} onClick={() => void sourceAction('archive')}>{current?.archived ? '取消归档' : '归档证据'}</Button></div></div>}
    {selected !== undefined && scopeRef.current && <EvidenceEditor key={selected ? `editor:${selected.id}:${selected.currentVersion}` : `new:${paperId}`}  paperId={paperId} projectIds={projectId ? [projectId] : []} papers={papers} projects={projects} initial={current} revision={revision} save={input => {
      const accepted = scopeRef.current!
      return selected ? libraryEvidenceApi().update({ scope: accepted, cardId: selected.id, expectedRevision: revision, input }) : libraryEvidenceApi().create({ scope: accepted, expectedRevision: revision, input })
    }} onSaved={applied} onCancel={() => { setSelected(undefined); void load(++generation.current); newButton.current?.focus() }} />}
    {selected && <EvidenceHistory key={`history:${selected.id}:${selected.currentVersion}`} card={selected} onOpenSource={version => void sourceAction('open', version)} />}
  </section>
}
