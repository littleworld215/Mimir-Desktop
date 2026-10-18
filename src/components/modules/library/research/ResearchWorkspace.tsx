import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { hasEvidenceWork, requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import { libraryResearchApi } from '@/lib/libraryResearchApi'
import { libraryEvidenceApi } from '@/lib/libraryEvidenceApi'
import type { EvidenceVersion, SourceOpenResult } from '../../../../../shared/libraryEvidenceContracts'
import type { ResearchPackDetail, ResearchPackReply, ResearchPackSummary, ResearchQuestionDetail, ResearchQuestionReply, ResearchQuestionSummary, ResearchReadState, ResearchScope, ResearchResolvedItem } from '../../../../../shared/libraryResearchContracts'
import type { PaperRecord, ProjectRecord } from '../types'
import { QuestionEditor } from './QuestionEditor'
import { MaterialPackEditor } from './MaterialPackEditor'
import { QuestionList } from './QuestionList'
import { MaterialPackList } from './MaterialPackList'
import { QuestionComparison } from './QuestionComparison'
import { ResearchHistory } from './ResearchHistory'
import { ReferenceRefreshDialog } from './ReferenceRefreshDialog'
import { MaterialExportDialog } from './MaterialExportDialog'
import { referenceWarnings, ResearchContent, researchSourceLabel } from './ResearchContent'
import { researchControl, researchMessage, useResearchBusy } from './useResearchForm'

type Choice = { kind: 'question'; base: ResearchReadState; detail?: ResearchQuestionDetail } | { kind: 'pack'; base: ResearchReadState; detail?: ResearchPackDetail }
const emptyState: ResearchReadState = { revision: 0, evidenceRevision: 0, evidenceState: 'absent' }
export function ResearchWorkspace({ projectId, projects }: { projectId?: string; papers: PaperRecord[]; projects: ProjectRecord[] }) {
  const projectKey = projectId ?? '', [boot, setBoot] = useState<{ scope: ResearchScope; projectKey: string }>(), [state, setState] = useState(emptyState), [bootRetry, setBootRetry] = useState(0)
  const [kind, setKind] = useState<'questions' | 'packs'>('questions'), [keyword, setKeyword] = useState(''), [archive, setArchive] = useState<'exclude' | 'include' | 'only'>('exclude'), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0)
  const [questions, setQuestions] = useState<ResearchQuestionSummary[]>([]), [packs, setPacks] = useState<ResearchPackSummary[]>([]), [options, setOptions] = useState<ResearchQuestionSummary[]>([]), [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Choice>(), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [refreshOpen, setRefreshOpen] = useState(false), [exportOpen, setExportOpen] = useState(false), [readOnly, setReadOnly] = useState<{ cardId: string; evidence: EvidenceVersion }>(), [source, setSource] = useState<SourceOpenResult>()
  const bootGeneration = useRef(0), listGeneration = useRef(0), detailGeneration = useRef(0), busyRef = useRef(false), selection = useRef(selected), newButton = useRef<HTMLButtonElement>(null), restoreFocus = useRef(false)
  selection.current = selected
  const accepted = boot?.projectKey === projectKey ? boot.scope : undefined, scopeRef = useRef(accepted); scopeRef.current = accepted
  useResearchBusy(busy)
  const put = (choice?: Choice) => { selection.current = choice; setSelected(choice) }
  useEffect(() => {
    const token = ++bootGeneration.current; detailGeneration.current++; setBoot(undefined); put(undefined); setQuestions([]); setPacks([]); setPage(1); setLoading(true); setError(''); setReadOnly(undefined); setSource(undefined); setRefreshOpen(false); setExportOpen(false); busyRef.current = false; setBusy(false)
    void (async () => {
      try {
        const reply = await libraryResearchApi().overview({})
        if (bootGeneration.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        setState(reply); setBoot({ scope: reply.scope, projectKey })
      } catch (failure) { if (bootGeneration.current === token) { setError(researchMessage(failure)); setLoading(false) } }
    })()
    return () => { bootGeneration.current++; detailGeneration.current++ }
  }, [projectKey, bootRetry])
  useEffect(() => {
    if (!accepted) return
    const token = ++listGeneration.current; setLoading(true); setError('')
    const timer = setTimeout(() => { void (async () => {
      try {
        const api = libraryResearchApi(), filter = { projectId, keyword, archive }
        if (kind === 'questions') {
          const reply = await api.listQuestions({ scope: accepted, filter, page })
          if (listGeneration.current !== token) return
          if (!reply.ok) throw Error(reply.message)
          setQuestions(reply.items); setState(reply); setTotal(reply.total)
        } else {
          const reply = await api.listPacks({ scope: accepted, filter, page })
          if (listGeneration.current !== token) return
          if (!reply.ok) throw Error(reply.message)
          setPacks(reply.items); setState(reply); setTotal(reply.total)
        }
      } catch (failure) { if (listGeneration.current === token) setError(researchMessage(failure)) }
      finally { if (listGeneration.current === token) setLoading(false) }
    })() }, 150)
    return () => { clearTimeout(timer); listGeneration.current++ }
  }, [accepted?.workspaceId, accepted?.spaceEpoch, projectKey, kind, keyword, archive, page, refresh])
  useEffect(() => {
    if (!accepted || kind !== 'packs') { setOptions([]); return }
    let active = true
    void (async () => {
      try {
        const result: ResearchQuestionSummary[] = []; let firstRevision: number | undefined
        for (let p = 1; p <= 4; p++) {
          const reply = await libraryResearchApi().listQuestions({ scope: accepted, filter: { projectId, archive: 'exclude' }, page: p })
          if (!active) return
          if (!reply.ok) throw Error(reply.message)
          if (firstRevision !== undefined && firstRevision !== reply.revision) throw Error('问题组选项读取期间已变化，请刷新列表')
          firstRevision = reply.revision; result.push(...reply.items)
          if (p * 50 >= reply.total) break
        }
        if (active) setOptions(result)
      } catch (failure) { if (active) { setOptions([]); setError(researchMessage(failure)) } }
    })()
    return () => { active = false }
  }, [accepted?.workspaceId, accepted?.spaceEpoch, kind, projectKey, refresh])
  async function readDetail(type: 'question' | 'pack', id: string, version?: number) {
    const scope = scopeRef.current
    if (!scope) return
    const token = ++detailGeneration.current; busyRef.current = true; setBusy(true); setError('')
    try {
      const api = libraryResearchApi()
      if (type === 'question') {
        const reply = await api.questionDetail({ scope, questionId: id, version, page: 1 })
        if (detailGeneration.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        put({ kind: 'question', base: reply, detail: reply })
      } else {
        const reply = await api.packDetail({ scope, packId: id, version })
        if (detailGeneration.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        put({ kind: 'pack', base: reply, detail: reply })
      }
    } catch (failure) { if (detailGeneration.current === token) setError(researchMessage(failure)) }
    finally { if (detailGeneration.current === token) { busyRef.current = false; setBusy(false) } }
  }
  async function choose(type: 'question' | 'pack', id?: string, version?: number) {
    if (!await requestEvidenceLeave() || busyRef.current || !scopeRef.current) return
    setError(''); setNotice('')
    if (id) await readDetail(type, id, version)
    else { detailGeneration.current++; put({ kind: type, base: { ...state } }) }
  }
  async function switchKind(next: 'questions' | 'packs') { if (await requestEvidenceLeave() && !busyRef.current) { detailGeneration.current++; put(undefined); setKind(next); setPage(1); setError('') } }
  function appliedQuestion(reply: ResearchQuestionReply) { setNotice('问题已保存'); setRefresh(v => v + 1); void readDetail('question', reply.question.id) }
  function appliedPack(reply: ResearchPackReply) { setRefreshOpen(false); setNotice('素材包已保存，历史引用保留'); setRefresh(v => v + 1); void readDetail('pack', reply.pack.id) }
  async function archiveSelected() {
    if (!await requestEvidenceLeave() || busyRef.current) return
    const s = selection.current, scope = scopeRef.current
    if (!s || !scope || !s.detail) return
    const token = ++detailGeneration.current; busyRef.current = true; setBusy(true); setError('')
    try {
      if (s.kind === 'question' && s.detail) {
        const q = s.detail.question, reply = await libraryResearchApi().archiveQuestion({ scope, questionId: q.id, expectedRevision: s.base.revision, archived: !q.versions[q.currentVersion - 1]!.archived })
        if (detailGeneration.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        setRefresh(v => v + 1); await readDetail('question', q.id)
      } else if (s.kind === 'pack' && s.detail) {
        const p = s.detail.pack, reply = await libraryResearchApi().archivePack({ scope, packId: p.id, expectedRevision: s.base.revision, archived: !p.versions[p.currentVersion - 1]!.archived })
        if (detailGeneration.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        setRefresh(v => v + 1); await readDetail('pack', p.id)
      }
    } catch (failure) { if (detailGeneration.current === token) setError(researchMessage(failure)) }
    finally { if (detailGeneration.current === token) { busyRef.current = false; setBusy(false) } }
  }
  async function openCard(cardId: string) {
    if (busyRef.current || !scopeRef.current) return
    const token = detailGeneration.current, scope = scopeRef.current; busyRef.current = true; setBusy(true)
    try {
      const reply = await libraryEvidenceApi().detail({ scope, cardId })
      if (detailGeneration.current !== token) return
      if (!reply.ok) throw Error(reply.message)
      setSource(undefined); setReadOnly({ cardId, evidence: reply.card.versions[reply.card.currentVersion - 1]! })
    } catch (failure) { if (detailGeneration.current === token) setError(researchMessage(failure)) }
    finally { if (detailGeneration.current === token) { busyRef.current = false; setBusy(false) } }
  }
  async function openSource() {
    if (!readOnly || !scopeRef.current || busyRef.current) return
    const token = detailGeneration.current; busyRef.current = true; setBusy(true)
    try {
      const reply = await libraryEvidenceApi().openSource({ scope: scopeRef.current, cardId: readOnly.cardId, version: readOnly.evidence.version })
      if (detailGeneration.current !== token) return
      if (!reply.ok) throw Error(reply.message)
      setSource(reply.source)
    } catch (failure) { if (detailGeneration.current === token) setError(researchMessage(failure)) }
    finally { if (detailGeneration.current === token) { busyRef.current = false; setBusy(false) } }
  }
  const q = selected?.kind === 'question' ? selected.detail : undefined, p = selected?.kind === 'pack' ? selected.detail : undefined
  const current = q ? q.selectedVersion === q.question.currentVersion : p ? p.selectedVersion === p.pack.currentVersion : true
  const editorDisabled = busy || refreshOpen || exportOpen || Boolean(readOnly), canCreate = Boolean(projectId && projects.some(p => p.id === projectId))
  const cancel = () => { detailGeneration.current++; busyRef.current = false; restoreFocus.current = true; setBusy(false); put(undefined) }
  useEffect(() => {
    if (restoreFocus.current && !selected && !busy && !loading && newButton.current && !newButton.current.disabled) { restoreFocus.current = false; newButton.current.focus() }
  }, [selected, busy, loading])
  const viewPinned = (item: ResearchResolvedItem) => { if (item.evidence) { setSource(undefined); setReadOnly({ cardId: item.item.cardId, evidence: item.evidence }) } else setError('引用版本不可读，原组织信息仍保留') }
  return <section className="min-w-0 space-y-3 text-foreground" aria-label="研究问题与写作素材">
    <p className="text-sm text-muted-foreground">围绕问题比较证据，再组织写作素材。人工整理，不自动生成科研结论。</p>
    <div className="flex flex-wrap gap-2"><Button variant={kind === 'questions' ? 'default' : 'outline'} onClick={() => void switchKind('questions')}>研究问题</Button><Button variant={kind === 'packs' ? 'default' : 'outline'} onClick={() => void switchKind('packs')}>写作素材</Button><Button ref={newButton} disabled={!accepted || loading || busy || !canCreate} onClick={() => void choose(kind === 'questions' ? 'question' : 'pack')}>{kind === 'questions' ? '新建问题' : '新建素材包'}</Button><Button variant="outline" disabled={busy} onClick={() => accepted ? setRefresh(v => v + 1) : setBootRetry(v => v + 1)}>刷新列表</Button></div>
    {!canCreate && <p className="text-xs">请先在项目栏选择一个有效课题再新建；全部范围仍可查看已有和失联记录。</p>}
    <div className="flex flex-wrap gap-2"><input aria-label="研究组织关键词" placeholder="搜索标题和说明" className={`${researchControl} min-w-48 flex-1`} value={keyword} onChange={e => { setPage(1); setKeyword(e.target.value) }} /><select aria-label="研究组织归档范围" className={`${researchControl} w-auto`} value={archive} onChange={e => { setPage(1); setArchive(e.target.value as typeof archive) }}><option value="exclude">非归档</option><option value="include">包含归档</option><option value="only">仅归档</option></select></div>
    {loading && <p role="status">正在读取研究资料…</p>}{error && <p role="alert" className="whitespace-pre-wrap break-words text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]"><aside className="space-y-2">{kind === 'questions' ? <QuestionList items={questions} busy={busy} onSelect={id => void choose('question', id)} /> : <MaterialPackList items={packs} busy={busy} onSelect={id => void choose('pack', id)} />}{!loading && !total && <p className="text-sm text-muted-foreground">暂无匹配记录，可调整筛选或新建。</p>}<div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage(v => v - 1)}>上一页</Button><span className="text-xs">第{page}页 · {total}条</span><Button variant="outline" disabled={loading || page * 50 >= total} onClick={() => setPage(v => v + 1)}>下一页</Button></div></aside>
      <div className="min-w-0 space-y-3">{selected && accepted ? <>
        {selected.detail && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { const id = q?.question.id ?? p?.pack.id; if (id) void choose(selected.kind, id, q?.selectedVersion ?? p?.selectedVersion) }}>重新加载详情</Button><Button variant="outline" disabled={busy || !current} onClick={() => void archiveSelected()}>{(q?.question.versions.at(-1)?.archived ?? p?.pack.versions.at(-1)?.archived) ? '恢复归档' : '归档'}</Button>{p && <><Button variant="outline" disabled={busy || !current || p.evidenceRevision === null} onClick={() => { if (hasEvidenceWork()) { setError('请先保存或取消编辑，再更新引用'); return }; setRefreshOpen(true) }}>更新引用</Button><Button disabled={busy || p.evidenceRevision === null} onClick={() => { if (hasEvidenceWork()) { setError('请先保存或取消编辑，再预览导出'); return }; setExportOpen(true) }}>导出素材</Button></>}</div>}
        {q && <ResearchHistory entity={q.question} selectedVersion={q.selectedVersion} busy={busy} onSelect={v => void choose('question', q.question.id, v)} />}{p && <ResearchHistory entity={p.pack} selectedVersion={p.selectedVersion} busy={busy} onSelect={v => void choose('pack', p.pack.id, v)} />}
        {current && selected.kind === 'question' && <QuestionEditor key={q ? `${q.question.id}:${q.question.currentVersion}` : `new-q:${projectKey}`} scope={accepted} projectId={q?.question.versions[0]?.projectId ?? projectId ?? ''} initial={q?.question.versions[q.selectedVersion - 1]} revision={selected.base.revision} evidenceRevision={selected.base.evidenceRevision} externalBusy={editorDisabled} save={(input, expectedEvidenceRevision) => libraryResearchApi().saveQuestion({ scope: accepted, questionId: q?.question.id, expectedRevision: selected.base.revision, expectedEvidenceRevision, input })} onSaved={appliedQuestion} onCancel={cancel} />}
        {q && !current && <div className="whitespace-pre-wrap rounded border border-border p-3"><p>历史问题组织只读；证据比较仍使用卡片当前版本。</p><h3>{q.question.versions[q.selectedVersion - 1]!.title}</h3><p>{q.question.versions[q.selectedVersion - 1]!.question}</p><p>{q.question.versions[q.selectedVersion - 1]!.note}</p></div>}
        {current && selected.kind === 'pack' && <MaterialPackEditor key={p ? `${p.pack.id}:${p.pack.currentVersion}` : `new-p:${projectKey}`} scope={accepted} projectId={p?.pack.versions[0]?.projectId ?? projectId ?? ''} initial={p?.pack.versions[p.selectedVersion - 1]} revision={selected.base.revision} evidenceRevision={selected.base.evidenceRevision} questions={options} externalBusy={editorDisabled} save={(input, expectedEvidenceRevision) => libraryResearchApi().savePack({ scope: accepted, packId: p?.pack.id, expectedRevision: selected.base.revision, expectedEvidenceRevision, input })} onSaved={appliedPack} onCancel={cancel} />}
        {q && <QuestionComparison key={`${q.question.id}:${q.selectedVersion}:${q.question.currentVersion}`} scope={accepted} initial={q} onOpenCard={id => void openCard(id)} />}
        {p && <section className="space-y-2" aria-label="固定版本素材"><h3 className="font-medium">{p.pack.versions[p.selectedVersion - 1]!.title} · 素材v{p.selectedVersion}{!current ? '（历史只读）' : ''}</h3>{p.items.map(item => <details className="rounded border border-border p-2" key={item.item.id}><summary className="cursor-pointer text-sm">{item.item.section || '未指定小节'} · {item.question?.title ?? '问题历史缺失'} · 固定证据v{item.item.evidenceVersion}</summary><p className="text-xs text-destructive">{referenceWarnings(item).join('；')}</p><p className="text-xs">{researchSourceLabel(item.sourceStatus)} · {item.item.note}</p><ResearchContent evidence={item.evidence} question={item.question} /><Button variant="outline" onClick={() => viewPinned(item)}>查看引用版本与原文</Button></details>)}</section>}
      </> : <p className="text-sm text-muted-foreground">选择问题或素材包查看详情；未分组证据仍在原比较矩阵中。</p>}</div>
    </div>
    {p && accepted && refreshOpen && p.evidenceRevision !== null && <ReferenceRefreshDialog scope={accepted} packId={p.pack.id} revision={p.revision} evidenceRevision={p.evidenceRevision} items={p.items} onApplied={appliedPack} onClose={() => setRefreshOpen(false)} />}
    {p && accepted && exportOpen && p.evidenceRevision !== null && <MaterialExportDialog scope={accepted} packId={p.pack.id} packVersion={p.selectedVersion} revision={p.revision} evidenceRevision={p.evidenceRevision} onClose={() => setExportOpen(false)} />}
    {readOnly && <Dialog open onOpenChange={open => { if (!open && !busyRef.current) { setReadOnly(undefined); setSource(undefined) } }}><DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>证据完整内容 · v{readOnly.evidence.version}</DialogTitle><DialogDescription>只读查看所选版本；编辑证据仍使用文献阅读器原入口。</DialogDescription></DialogHeader><ResearchContent evidence={readOnly.evidence} /><Button disabled={busy} onClick={() => void openSource()}>打开原文</Button>{source && <p role="status">{researchSourceLabel(source.status)} · PDF物理页{source.requestedPage ?? '未填'} · 请按页码人工定位</p>}{source?.pdfUrl && <iframe src={source.pdfUrl} title="研究证据来源PDF" className="h-96 w-full" />}</DialogContent></Dialog>}
  </section>
}
