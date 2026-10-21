import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { Bookmark, Loader2, Settings2, Database, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProjectBar } from './ProjectBar'
import { PaperMatchDialog } from './PaperMatchDialog'
import { useWebPaperMatch } from './useWebPaperMatch'
import { SearchPanel, type SearchSource } from './SearchPanel'
import { SubscriptionsBar } from './SubscriptionsBar'
import { PaperCard } from './PaperCard'
import { PaperReader } from './PaperReader'
import { requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import { consumePlanningHostIntent, samePlanningHostScope } from '@/lib/planningHostNavigation'
import { EvidenceMatrix } from './evidence/EvidenceMatrix'
import { handoffToAgent } from '@/lib/agentContext'
import type {
  ArxivEntry,
  ArxivSubscriptionView,
  PaperRecord,
  ProjectRecord,
  SearchResult,
  SubscriptionCheckOutcome,
  WebSearchEntry,
  ZoteroCollection
} from './types'

const ResearchWorkspace = lazy(() => import('./research/ResearchWorkspace').then(module => ({ default: module.ResearchWorkspace })))

export function Library() {
  const api = window.electronAPI!
  const [planningIntent] = useState(() => consumePlanningHostIntent('library'))

  // 项目
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  // 论文
  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [loadingPapers, setLoadingPapers] = useState(true)

  // 搜索
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SearchSource>('arxiv')
  const [sortBy, setSortBy] = useState<'relevance' | 'submittedDate'>('relevance')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

  // 订阅
  const [subscriptions, setSubscriptions] = useState<ArxivSubscriptionView[]>([])

  // PDF 阅读器
  const [readerPaper, setReaderPaper] = useState<PaperRecord | null>(null)
  const [readerTab, setReaderTab] = useState<'notes' | 'evidence'>('notes')
  const [libraryView, setLibraryView] = useState<'papers' | 'matrix' | 'research'>('papers')

  // Zotero
  const [zoteroOpen, setZoteroOpen] = useState(false)
  const [zoteroApiKey, setZoteroApiKey] = useState('')
  const [zoteroUserId, setZoteroUserId] = useState('')
  const [zoteroCollections, setZoteroCollections] = useState<ZoteroCollection[]>([])
  const [zoteroBusy, setZoteroBusy] = useState(false)
  const [zoteroMessage, setZoteroMessage] = useState('')

  const [globalError, setGlobalError] = useState('')

  const loadProjects = useCallback(async () => {
    const res = await api.library.listProjects()
    if (res.ok && res.projects) {
      setProjects(res.projects as ProjectRecord[])
      return true
    }
    return false
  }, [])

  const loadPapers = useCallback(async () => {
    setLoadingPapers(true)
    try {
      const res = await api.library.listPapers()
      if (res.ok && res.papers) {
        setPapers(res.papers as PaperRecord[])
      } else if (res.message) {
        setGlobalError(res.message)
      }
    } finally {
      setLoadingPapers(false)
    }
  }, [])

  const loadSubscriptions = useCallback(async () => {
    const res = await api.library.listSubscriptions()
    if (res.ok && res.subscriptions) {
      setSubscriptions(res.subscriptions as ArxivSubscriptionView[])
    }
  }, [])

  const webMatch = useWebPaperMatch(selectedProjectId, loadPapers, setGlobalError)

  useEffect(() => {
    loadProjects()
    loadPapers()
    loadSubscriptions()
  }, [loadProjects, loadPapers, loadSubscriptions])

  useEffect(() => {
    if (!planningIntent) return
    let active = true
    void (async () => {
      try {
        const current = await api.researchPlanning.bootstrap({})
        if (!current.ok || !samePlanningHostScope(current.scope, planningIntent.scope)) throw Error('科研空间已变化，已取消关联跳转。')
        if (planningIntent.kind === 'paper') {
          const result = await api.library.listPapers()
          const paper = (result.papers as PaperRecord[] | undefined)?.find(p => p.arxivId === planningIntent.id)
          if (!result.ok || !paper) throw Error('关联文献已失联，原计划记录保留。')
          if (active) { setSelectedProjectId(null); setLibraryView('papers'); setReaderTab('notes'); setReaderPaper(paper) }
        } else {
          const result = await api.library.listProjects()
          if (!result.ok || !(result.projects as ProjectRecord[] | undefined)?.some(p => p.id === planningIntent.id)) throw Error('关联文献项目已失联，原计划记录保留。')
          if (active) { setSelectedProjectId(planningIntent.id); setLibraryView('papers') }
        }
      } catch (failure) { if (active) setGlobalError(failure instanceof Error ? failure.message : '关联跳转未完成') }
    })()
    return () => { active = false }
  }, [planningIntent])

  // ─── 搜索 ────────────────────────────────────────────────────────
  const handleSearch = async () => {
    if (!query.trim() || isSearching) return
    setIsSearching(true)
    setSearchError('')
    try {
      if (source === 'arxiv') {
        const res = await api.library.searchArxiv(query.trim(), 10, sortBy)
        if (res.ok && res.entries) {
          setResults(res.entries as ArxivEntry[])
        } else {
          setSearchError(res.message || 'arXiv 搜索失败')
        }
      } else {
        const res = await api.library.searchWeb(query.trim(), 10)
        if (res.ok && res.entries) {
          setResults(res.entries as WebSearchEntry[])
        } else {
          setSearchError(res.message || 'Web 搜索失败')
        }
      }
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : '搜索失败')
    } finally {
      setIsSearching(false)
    }
  }

  // ─── 论文操作 ────────────────────────────────────────────────────
  const handleImport = async (entry: ArxivEntry | WebSearchEntry) => {
    try {
      if ('id' in entry) {
        const res = await api.library.importPaper(entry, selectedProjectId ?? undefined)
        if (res.ok) {
          await loadPapers()
        } else {
          setGlobalError(res.message || '导入失败')
        }
      } else {
        await webMatch.begin(entry)
      }
    } catch (failure) { setGlobalError(failure instanceof Error ? failure.message : '导入失败') }
  }

  const handleRemove = async (arxivId: string) => {
    if (!window.confirm('从文献库移除这篇论文？')) return
    const res = await api.library.removePaper(arxivId)
    if (res.ok) {
      await loadPapers()
    } else {
      setGlobalError(res.message || '删除失败')
    }
  }

  const handleUpdate = async (request: { arxivId: string; tags?: string[]; projectIds?: string[]; notes?: string }) => {
    const res = await api.library.updatePaper(request)
    if (res.ok) {
      await loadPapers()
    } else {
      setGlobalError(res.message || '更新失败')
    }
  }

  const handleDownloadPdf = async (arxivId: string) => {
    const res = await api.library.fetchPaperPdf(arxivId)
    if (res.ok) {
      await loadPapers()
    } else {
      setGlobalError(res.message || 'PDF 下载失败')
    }
  }

  const handleOpenPdf = (paper: PaperRecord) => {
    if (!paper.pdfPath) {
      setGlobalError('请先下载 PDF')
      return
    }
    setReaderTab('notes'); setReaderPaper(paper)
  }

  const handleScoreRelevance = async (paper: PaperRecord) => {
    if (!selectedProjectId) {
      setGlobalError('请先选择项目')
      return
    }
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const res = await api.library.scoreRelevance(paper, selectedProjectId, project.title)
    if (res.ok) {
      await loadPapers()
      if (res.message) setGlobalError(res.message)
    } else {
      setGlobalError(res.message || 'AI 评分失败')
    }
  }

  const handleExportBib = async (paper: PaperRecord) => {
    if (!selectedProjectId) {
      setGlobalError('请先选择项目')
      return
    }
    const res = await api.library.importPapersToBib(selectedProjectId, [paper.arxivId])
    if (res.ok) {
      setGlobalError(
        res.added && res.added.length > 0
          ? `已加入 references.bib（${res.bibPath}）`
          : '该论文已在 references.bib 中'
      )
    } else {
      setGlobalError(res.message || 'BibTeX 导出失败')
    }
  }

  /** 把文献作为上下文交给 Agent：携带标题/作者/摘要 + PDF 绝对路径。 */
  const handleHandoffToAgent = useCallback((paper: PaperRecord) => {
    const excerpt = [
      `标题：${paper.title}`,
      paper.authors.length > 0 ? `作者：${paper.authors.join(', ')}` : '',
      paper.summary.trim() !== '' ? `摘要：${paper.summary}` : '',
      paper.notes.trim() !== '' ? `已有笔记：${paper.notes}` : '',
      `arXiv：${paper.arxivId}`
    ]
      .filter((line) => line !== '')
      .join('\n')
    handoffToAgent({
      kind: 'library-item',
      refId: paper.arxivId,
      title: paper.title,
      excerpt,
      ...(paper.pdfPath ? { spacePath: paper.pdfPath } : {}),
      meta: { url: paper.url, tags: paper.tags }
    })
  }, [])

  // ─── 项目操作 ────────────────────────────────────────────────────
  const handleCreateProject = async (title: string) => {
    if (!await requestEvidenceLeave()) return false
    const res = await api.library.createProject(title)
    if (res.ok) {
      // 写入已确认成功，刷新失败不能让编辑器提示重试创建。
      try {
        if (!await loadProjects()) setGlobalError('项目已创建，列表刷新失败，请重新打开文献库')
      } catch { setGlobalError('项目已创建，列表刷新失败，请重新打开文献库') }
      if (res.project) {
        setSelectedProjectId((res.project as ProjectRecord).id)
      }
    } else {
      setGlobalError(res.message || '创建项目失败')
    }
    return res.ok
  }

  const handleRenameProject = async (id: string, title: string) => {
    const res = await api.library.updateProject(id, { title })
    if (res.ok) {
      try {
        if (!await loadProjects()) setGlobalError('项目已重命名，列表刷新失败，请重新打开文献库')
      } catch { setGlobalError('项目已重命名，列表刷新失败，请重新打开文献库') }
    } else {
      setGlobalError(res.message || '重命名失败')
    }
    return res.ok
  }

  const handleDeleteProject = async (id: string) => {
    if (!await requestEvidenceLeave()) return
    const res = await api.library.deleteProject(id)
    if (res.ok) {
      if (selectedProjectId === id) setSelectedProjectId(null)
      await loadProjects()
      await loadPapers()
    } else {
      setGlobalError(res.message || '删除项目失败')
    }
  }

  // ─── 订阅操作 ────────────────────────────────────────────────────
  const handleSaveSubscription = async (q: string) => {
    const res = await api.library.saveSubscription(q)
    if (res.ok) {
      await loadSubscriptions()
    } else {
      setGlobalError(res.message || '保存订阅失败')
    }
  }

  const handleDeleteSubscription = async (id: string) => {
    const res = await api.library.deleteSubscription(id)
    if (res.ok) {
      await loadSubscriptions()
    } else {
      setGlobalError(res.message || '删除订阅失败')
    }
  }

  const handleCheckSubscriptions = async (id?: string): Promise<SubscriptionCheckOutcome[]> => {
    const res = await api.library.checkSubscriptions(id)
    if (res.ok && res.outcomes) {
      await loadSubscriptions()
      return res.outcomes as SubscriptionCheckOutcome[]
    }
    setGlobalError(res.message || '检查订阅失败')
    return []
  }

  // ─── Zotero ──────────────────────────────────────────────────────
  const openZotero = async () => {
    setZoteroOpen(true)
    setZoteroMessage('')
    const settings = await api.getSettings()
    const z = (settings.zotero as { apiKey?: string; userId?: string } | undefined) ?? {}
    setZoteroApiKey(z.apiKey ?? '')
    setZoteroUserId(z.userId ?? '')
    await refreshZoteroCollections(z.apiKey ?? '', z.userId ?? '')
  }

  const refreshZoteroCollections = async (apiKey: string, userId: string) => {
    if (!apiKey || !userId) {
      setZoteroCollections([])
      return
    }
    setZoteroBusy(true)
    try {
      const res = await api.library.listZoteroCollections()
      if (res.ok && res.collections) {
        setZoteroCollections(res.collections as ZoteroCollection[])
      } else {
        setZoteroMessage(res.message || '读取 Zotero 集合失败')
      }
    } finally {
      setZoteroBusy(false)
    }
  }

  const saveZoteroConfig = async () => {
    const settings = await api.getSettings()
    await api.setSettings({
      ...settings,
      zotero: { apiKey: zoteroApiKey.trim(), userId: zoteroUserId.trim() }
    })
    await refreshZoteroCollections(zoteroApiKey.trim(), zoteroUserId.trim())
  }

  const exportZoteroCollection = async (collectionKey: string) => {
    if (!selectedProjectId) {
      setZoteroMessage('请先选择项目')
      return
    }
    setZoteroBusy(true)
    try {
      const res = await api.library.exportZoteroCollectionToBib(selectedProjectId, collectionKey)
      if (res.ok) {
        setZoteroMessage(
          res.added && res.added.length > 0
            ? `已导出 ${res.added.length} 条到 references.bib（${res.bibPath}）`
            : '集合条目已全部在 references.bib 中'
        )
      } else {
        setZoteroMessage(res.message || 'Zotero 导出失败')
      }
    } finally {
      setZoteroBusy(false)
    }
  }

  // ─── 过滤与展示 ──────────────────────────────────────────────────
  const savedIds = new Set(papers.map((p) => p.arxivId))
  const filteredPapers = selectedProjectId
    ? papers.filter((p) => p.projectIds.includes(selectedProjectId))
    : papers

  const handleOpenExternal = (url: string) => {
    window.open(url, '_blank')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="module-header">
        <div className="flex items-center gap-3">
          <span className="module-title">文献库</span>
          <span className="text-[11px] text-muted-foreground">{papers.length} 篇论文</span>
          {selectedProjectId && (
            <span className="text-[11px] text-primary">
              {filteredPapers.length} 篇 · {projects.find((p) => p.id === selectedProjectId)?.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={openZotero}
          >
            <Database className="h-3.5 w-3.5 mr-1" />
            Zotero
          </Button>
        </div>
      </div>

      {/* 项目选择器 */}
      <div className="shrink-0 px-5 py-2 border-b border-border">
        <div className="mb-2 flex flex-wrap gap-2"><Button variant="outline" onClick={async () => { if (await requestEvidenceLeave()) setLibraryView(value => value === 'matrix' ? 'papers' : 'matrix') }}>{libraryView === 'matrix' ? '返回文献列表' : '证据比较矩阵'}</Button><Button variant="outline" onClick={async () => { if (await requestEvidenceLeave()) setLibraryView(value => value === 'research' ? 'papers' : 'research') }}>{libraryView === 'research' ? '返回文献列表' : '研究问题与写作素材'}</Button></div>
        <ProjectBar
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelect={async id => { if (await requestEvidenceLeave()) setSelectedProjectId(id) }}
          onCreate={handleCreateProject}
          onRename={handleRenameProject}
          onDelete={handleDeleteProject}
        />
      </div>

      {/* 搜索面板 */}
      <SearchPanel
        query={query}
        onQueryChange={setQuery}
        source={source}
        onSourceChange={setSource}
        sortBy={sortBy}
        onSortByChange={setSortBy}
        results={results}
        isSearching={isSearching}
        error={searchError}
        onSearch={handleSearch}
        savedIds={savedIds}
        onImport={handleImport}
        onRemove={handleRemove}
        onOpenExternal={handleOpenExternal}
      />

      {/* 订阅栏 */}
      <SubscriptionsBar
        subscriptions={subscriptions}
        onSave={handleSaveSubscription}
        onDelete={handleDeleteSubscription}
        onCheck={handleCheckSubscriptions}
        onOpenExternal={handleOpenExternal}
      />

      {/* 论文列表 */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {globalError && (
          <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-[11px] text-primary flex items-center justify-between">
            <span>{globalError}</span>
            <button onClick={() => setGlobalError('')} className="text-primary/50 hover:text-primary">
              ✕
            </button>
          </div>
        )}

        {libraryView === 'research' ? <Suspense fallback={<p role="status">正在打开研究问题与写作素材…</p>}><ResearchWorkspace projectId={selectedProjectId ?? undefined} papers={papers} projects={projects} /></Suspense> : libraryView === 'matrix' ? <EvidenceMatrix projectId={selectedProjectId ?? undefined} papers={papers} projects={projects} /> : loadingPapers ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mb-2" />
            <p className="text-[12px]">加载文献库...</p>
          </div>
        ) : filteredPapers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Bookmark className="h-8 w-8 opacity-30 mb-3" />
            <p className="text-[12px] font-medium">
              {selectedProjectId ? '该项目暂无论文' : '文献库为空'}
            </p>
            <p className="text-[11px] mt-0.5 opacity-70">
              {selectedProjectId ? '在上方搜索并导入论文，或从其他项目关联' : '搜索 arXiv / Web 并导入论文'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredPapers.map((paper) => (
              <PaperCard
                key={paper.arxivId}
                paper={paper}
                projects={projects}
                selectedProjectId={selectedProjectId}
                onUpdate={handleUpdate}
                onRemove={handleRemove}
                onDownloadPdf={handleDownloadPdf}
                onOpenPdf={handleOpenPdf}
                onEvidence={async paper => { if (await requestEvidenceLeave()) { setReaderTab('evidence'); setReaderPaper(paper) } }}
                onOpenExternal={handleOpenExternal}
                onScoreRelevance={handleScoreRelevance}
                onExportBib={handleExportBib}
                onHandoffToAgent={handleHandoffToAgent}
              />
            ))}
          </div>
        )}
      </div>

      {/* PDF 阅读器 */}
      {webMatch.match && <PaperMatchDialog
        key={webMatch.match.generation}
        source={webMatch.match.source}
        candidates={webMatch.match.candidates}
        trigger={webMatch.match.trigger}
        busy={webMatch.busy}
        error={webMatch.error}
        onClose={webMatch.close}
        onConfirm={webMatch.confirm}
      />}
      {readerPaper && (
        <PaperReader
          key={`${readerPaper.arxivId}:${readerTab}`}
          paper={readerPaper}
          initialTab={readerTab}
          projectId={selectedProjectId ?? undefined}
          projects={projects}
          papers={papers}
          onClose={() => setReaderPaper(null)}
          onUpdateNotes={async (arxivId, notes) => {
            await handleUpdate({ arxivId, notes })
            setReaderPaper((prev) => (prev ? { ...prev, notes } : prev))
          }}
          onOpenExternal={handleOpenExternal}
        />
      )}

      {/* Zotero 对话框 */}
      <Dialog open={zoteroOpen} onOpenChange={setZoteroOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              Zotero 集成
            </DialogTitle>
            <DialogDescription>
              配置 Zotero Web API（my.zotero.org → Settings → Feeds/API），将集合导出为 BibTeX 合并到项目 references.bib。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-[11px]">API Key</Label>
              <Input
                value={zoteroApiKey}
                onChange={(e) => setZoteroApiKey(e.target.value)}
                placeholder="Zotero API Key"
                className="h-8 text-[12px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">User ID</Label>
              <Input
                value={zoteroUserId}
                onChange={(e) => setZoteroUserId(e.target.value)}
                placeholder="Zotero User ID（数字）"
                className="h-8 text-[12px]"
              />
            </div>
            <Button size="sm" className="h-7 text-[11px]" onClick={saveZoteroConfig} disabled={zoteroBusy}>
              {zoteroBusy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Settings2 className="h-3 w-3 mr-1" />}
              保存并加载集合
            </Button>
            {zoteroMessage && <p className="text-[11px] text-primary">{zoteroMessage}</p>}
            {zoteroCollections.length > 0 && (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                <p className="text-[11px] font-medium text-muted-foreground">集合（点击导出到当前项目）</p>
                {zoteroCollections.map((collection) => (
                  <button
                    key={collection.key}
                    onClick={() => exportZoteroCollection(collection.key)}
                    disabled={zoteroBusy}
                    className="flex w-full items-center justify-between rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] hover:border-primary/30 transition-colors"
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                      {collection.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{collection.numItems} 条</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button size="sm" className="h-7 text-[11px]" onClick={() => setZoteroOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
