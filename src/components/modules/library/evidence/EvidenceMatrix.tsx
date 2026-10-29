import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { initialEvidenceFilter, libraryEvidenceApi } from '@/lib/libraryEvidenceApi'
import { requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import type { EvidenceCardSummary, EvidenceFilter, EvidenceList, SourceOpenResult } from '../../../../../shared/libraryEvidenceContracts'
import type { PaperRecord, ProjectRecord } from '../types'
import type { LibraryBrowseSnapshot } from '@/lib/libraryBrowseState'
import { EvidencePanel, evidenceSourceLabels } from './EvidencePanel'
import { evidenceControl } from './EvidenceEditor'
import { EvidenceExportDialog } from './EvidenceExportDialog'

interface Props { projectId?: string; papers: PaperRecord[]; projects: ProjectRecord[]; initialBrowseState?: LibraryBrowseSnapshot['matrix']; onBrowseStateChange?(state: NonNullable<LibraryBrowseSnapshot['matrix']>): void }
export function EvidenceMatrix({ projectId, papers, projects, initialBrowseState, onBrowseStateChange }: Props) {
  const [filter, setFilter] = useState<EvidenceFilter>(() => initialBrowseState ? { ...initialBrowseState.filter, projectId: undefined } : initialEvidenceFilter()), [page, setPage] = useState(initialBrowseState?.page ?? 1), [currentProject, setCurrentProject] = useState(initialBrowseState ? Boolean(initialBrowseState.filter.projectId) : Boolean(projectId)), [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<EvidenceList>(), [loading, setLoading] = useState(true), [error, setError] = useState(''), [exportOpen, setExportOpen] = useState(false)
  const [selected, setSelected] = useState<{ paperId: string; cardId?: string }>(), [source, setSource] = useState<SourceOpenResult>()
  const generation = useRef(0), selectedFilter: EvidenceFilter = { ...filter, ...(currentProject && projectId ? { projectId } : {}) }, filterKey = JSON.stringify(selectedFilter)
  const previousProject = useRef(projectId), browseChange = useRef(onBrowseStateChange)
  browseChange.current = onBrowseStateChange
  useEffect(() => { if (previousProject.current !== projectId) { previousProject.current = projectId; setPage(1) } }, [projectId])
  useEffect(() => {
    if (result && !loading && !error) browseChange.current?.({ filter: selectedFilter, page, scrollTop: initialBrowseState?.scrollTop ?? 0 })
  }, [filterKey, page, loading, result?.revision, error])
  useEffect(() => {
    const token = ++generation.current; setLoading(true); setError('')
    const timer = setTimeout(() => { void (async () => {
      try {
        const api = libraryEvidenceApi(), boot = await api.list({ filter: initialEvidenceFilter(), page: 1 })
        if (generation.current !== token) return
        if (!boot.ok) throw Error(boot.message)
        const reply = await api.list({ scope: boot.scope, filter: selectedFilter, page })
        if (generation.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        const lastPage = Math.max(1, Math.ceil(reply.total / 50))
        if (page > lastPage) { setPage(lastPage); return }
        setResult(reply)
      } catch (failure) { if (generation.current === token) setError(failure instanceof Error ? failure.message : '矩阵读取失败，请重试') }
      finally { if (generation.current === token) setLoading(false) }
    })() }, 200)
    return () => { clearTimeout(timer); generation.current += 1 }
  }, [filterKey, page, projectId, refresh])
  function change(next: EvidenceFilter) { generation.current += 1; setLoading(true); setPage(1); setFilter(next) }
  async function closeDetails() { if (await requestEvidenceLeave()) { setSelected(undefined); setSource(undefined); setRefresh(value => value + 1) } }
  const columns = [['question', '研究问题'], ['method', '方法'], ['datasetOrMaterial', '数据或材料'], ['finding', '主要发现'], ['limitation', '局限']] as const
  function open(paperId: string, cardId?: string) { setSource(undefined); setSelected({ paperId, cardId }) }
  const cardButton = (paperId: string, card: EvidenceCardSummary, key: (typeof columns)[number][0]) => <button key={card.cardId} disabled={loading} className="mb-2 block w-full rounded border border-border p-2 text-left text-xs whitespace-pre-wrap break-words hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" aria-label={`查看证据 ${card.cardId} ${columns.find(c => c[0] === key)?.[1]}`} onClick={() => open(paperId, card.cardId)}><span className="font-medium">{card.cardId.slice(0, 8)} · 物理页 {card.locator.pageStart ?? '未填'}</span><br />{card[key] || '未填写'}</button>
  return <section className="space-y-3" aria-label="文献证据比较矩阵">
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs">比较范围<select aria-label="比较范围" className={evidenceControl} value={currentProject && projectId ? 'project' : 'all'} onChange={e => { generation.current += 1; setLoading(true); setPage(1); setCurrentProject(e.target.value === 'project') }}><option value="all">全部文献</option><option value="project" disabled={!projectId}>当前项目</option></select></label>
      <label className="min-w-48 flex-1 text-xs">证据关键词<input aria-label="证据关键词" className={evidenceControl} value={filter.keyword ?? ''} onChange={e => change({ ...filter, keyword: e.target.value })} /></label>
      <label className="text-xs">核对状态<select aria-label="核对状态" className={evidenceControl} value={filter.reviewState ?? 'all'} onChange={e => change({ ...filter, reviewState: e.target.value === 'all' ? undefined : e.target.value as 'draft' | 'checked' })}><option value="all">包含草稿</option><option value="draft">仅草稿</option><option value="checked">用户已核对</option></select></label>
      <label className="text-xs">归档范围<select aria-label="归档范围" className={evidenceControl} value={filter.archive} onChange={e => change({ ...filter, archive: e.target.value as EvidenceFilter['archive'] })}><option value="exclude">非归档</option><option value="include">含归档</option><option value="only">仅归档</option></select></label>
      <label className="text-xs">来源筛选<select aria-label="来源筛选" className={evidenceControl} value={filter.source} onChange={e => change({ ...filter, source: e.target.value as EvidenceFilter['source'] })}><option value="all">全部来源</option><option value="problem">已知来源异常</option></select></label>
      <Button variant="outline" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新矩阵</Button><Button disabled={loading || !result || Boolean(error)} onClick={() => setExportOpen(true)}>导出证据</Button>
    </div>
    <p className="text-xs text-muted-foreground">每格保留全部相关卡片；最多200码点为预览，点击查看完整内容。用户核对不等于事实验证，来源状态仅代表上次检查；未检查或未绑定不会伪装成异常。</p>
    {loading && <p role="status" className="text-sm">正在读取矩阵…</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="max-w-full overflow-x-auto rounded border border-border"><table aria-label="证据比较表" className="w-full border-collapse text-left text-sm"><thead className="bg-muted"><tr><th scope="col" className="sticky left-0 z-10 min-w-48 bg-muted p-2">文献</th>{columns.map(([key, name]) => <th key={key} scope="col" className="min-w-56 p-2">{name}</th>)}<th scope="col" className="min-w-64 p-2">用户判断与核对状态</th></tr></thead><tbody>{result?.rows.map(row => <tr key={row.paperId} className="border-t border-border"><th scope="row" className="sticky left-0 z-10 max-w-64 bg-card p-2 align-top font-normal"><button className="text-left font-medium text-primary break-words focus-visible:ring-2 focus-visible:ring-ring" disabled={loading} onClick={() => open(row.paperId)}>{row.paperSnapshot.title}</button><p className="text-xs break-all text-muted-foreground">{row.paperId}</p>{row.missingPaper && <p className="text-xs text-destructive">来源文献已移除，快照保留</p>}{row.missingProjectIds.length > 0 && <p className="text-xs text-destructive break-words">失效项目：{row.missingProjectIds.join('、')}</p>}</th>{columns.map(([key]) => <td key={key} className="p-2 align-top">{row.cards.length ? row.cards.map(c => cardButton(row.paperId, c, key)) : <span className="text-xs text-muted-foreground">尚无证据</span>}</td>)}<td className="p-2 align-top">{row.cards.map(c => <div className="mb-2 text-xs" key={c.cardId}><span>{c.cardId.slice(0, 8)} · {{ supports: '支持', opposes: '反对', mixed: '混合', unassessed: '未判断' }[c.relation]} · {c.reviewState === 'checked' ? '用户已核对' : '草稿'}{c.archived ? ' · 已归档' : ''}</span><p>{evidenceSourceLabels[c.sourceStatus]}{c.checkedAt ? ` · 上次检查 ${c.checkedAt}` : ''}</p></div>)}</td></tr>)}</tbody></table></div>
    {!loading && !error && result?.rows.length === 0 && <p className="text-sm text-muted-foreground">当前范围暂无匹配证据或文献，可调整筛选或手动创建证据卡。</p>}
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button><span className="text-xs">第 {page} 页 · {result?.total ?? 0} 篇文献 · 每页50篇</span><Button variant="outline" disabled={loading || !result || page * 50 >= result.total} onClick={() => setPage(value => value + 1)}>下一页</Button></div>
    {result && exportOpen && <EvidenceExportDialog scope={result.scope} revision={result.revision} filter={selectedFilter} onClose={() => setExportOpen(false)} />}
    {selected && result && <Dialog open onOpenChange={open => { if (!open) void closeDetails() }}><DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto" onEscapeKeyDown={e => { e.preventDefault(); void closeDetails() }}><DialogHeader><DialogTitle>证据详情</DialogTitle><DialogDescription>编辑与历史保留原字段；来源位置请按PDF物理页码人工核对。</DialogDescription></DialogHeader><EvidencePanel key={selected.paperId} scope={result.scope} paperId={selected.paperId} initialCardId={selected.cardId} projectId={currentProject ? projectId : undefined} papers={papers} projects={projects} onOpenSource={setSource} />{source && <p role="status" className="text-xs">{evidenceSourceLabels[source.status]} · PDF物理页 {source.requestedPage ?? '未填写'} · 请按页码定位</p>}{source?.pdfUrl && <iframe src={source.pdfUrl} title="证据来源PDF" className="h-80 w-full" />}</DialogContent></Dialog>}
  </section>
}
