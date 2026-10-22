import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Users,
  Calendar,
  FileDown,
  File,
  ExternalLink,
  Trash2,
  Loader2,
  Tag,
  Folder,
  BookOpen,
  Sparkles,
  FileText
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { isSubmitEnter } from '@/lib/keyboard'
import type { PaperRecord, PaperSaveResult, ProjectRecord } from './types'
import { usePaperEditGuard } from './usePaperEditGuard'
import { requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import { formatDate, readingNotesView } from './types'
import { paperDateLabels } from '../../../../shared/libraryDates'
import type { EditingDraft, EditingScope } from '../../../../shared/libraryEditingContracts'
import { usePaperRecoveryDraft } from './usePaperRecoveryDraft'
import { PaperDraftChoices } from './PaperDraftRecovery'

interface PaperCardProps {
  scope?: EditingScope
  onConfirmedPaper?: (paper: PaperRecord) => void
  recoverySelection?: EditingDraft
  paper: PaperRecord
  projects: ProjectRecord[]
  selectedProjectId: string | null
  onUpdate: (request: {
    arxivId: string
    tags?: string[]
    projectIds?: string[]
    notes?: string
  }) => Promise<PaperSaveResult>
  onRemove: (arxivId: string) => void
  onDownloadPdf: (arxivId: string) => Promise<void>
  onOpenPdf: (paper: PaperRecord) => void
  onEvidence?: (paper: PaperRecord) => void
  onOpenExternal: (url: string) => void
  onScoreRelevance: (paper: PaperRecord) => Promise<void>
  onExportBib: (paper: PaperRecord) => Promise<void>
  /** 把本篇文献作为上下文投递给 Agent（跳转对话）。 */
  onHandoffToAgent?: (paper: PaperRecord) => void
}

export function PaperCard({
  scope, onConfirmedPaper, recoverySelection,
  paper,
  projects,
  selectedProjectId,
  onUpdate,
  onRemove,
  onDownloadPdf,
  onOpenPdf,
  onEvidence,
  onOpenExternal,
  onScoreRelevance,
  onExportBib,
  onHandoffToAgent
}: PaperCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [tagText, setTagText] = useState(paper.tags.join(', '))
  const [editingNotes, setEditingNotes] = useState(false)
  const [noteText, setNoteText] = useState(paper.notes)
  const [downloading, setDownloading] = useState(false)
  const [scoring, setScoring] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [togglingProject, setTogglingProject] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveWarning, setSaveWarning] = useState('')
  const savingRef = useRef(false)
  const boundary = useRef({ alive: true, key: '' })
  boundary.current.key = `${scope?.workspaceId}:${scope?.spaceEpoch}:${paper.arxivId}`
  useEffect(() => { boundary.current.alive = true; return () => { boundary.current.alive = false } }, [])

  const relevance = selectedProjectId ? paper.relevance?.[selectedProjectId] : undefined
  const { plain: plainNotes, entries: readingNotes } = readingNotesView(paper.notes)

  const notesDirty = editingNotes && noteText !== paper.notes
  const tagsDirty = editingTags && tagText !== paper.tags.join(', ')
  const noteRecovery = usePaperRecoveryDraft({ scope: editingNotes ? scope : undefined, paperId: paper.arxivId, kind: 'notes', base: { notes: paper.notes }, input: noteText, onRestore: setNoteText, onConfirmedPaper })
  const tagRecovery = usePaperRecoveryDraft({ scope: editingTags ? scope : undefined, paperId: paper.arxivId, kind: 'tags', base: { tags: paper.tags }, input: tagText, onRestore: setTagText, onConfirmedPaper })
  useEffect(() => { if (!recoverySelection) return; setExpanded(true); if (recoverySelection.kind === 'tags') { setTagText(paper.tags.join(', ')); setEditingTags(true) } else { setNoteText(paper.notes); setEditingNotes(true) } }, [recoverySelection?.id])
  const discard = async () => {
    try { if (scope) { if (editingNotes) await noteRecovery.discard(); if (editingTags) await tagRecovery.discard() } }
    catch (e) { setSaveError(e instanceof Error ? e.message : '丢弃失败，输入保留'); throw e }
    setNoteText(paper.notes); setTagText(paper.tags.join(', '))
    setEditingNotes(false); setEditingTags(false); setSaveError('')
  }
  const persist = async (mode: 'notes' | 'tags' | 'all'): Promise<boolean> => {
    if (savingRef.current) return false
    const notes = mode === 'notes' || (mode === 'all' && notesDirty)
    const tags = mode === 'tags' || (mode === 'all' && tagsDirty)
    if (!notes && !tags) return true
    savingRef.current = true
    const key = boundary.current.key
    setSaving(true); setSaveError('')
    try {
      if (scope) {
        const writes = []
        if (notes) writes.push(await noteRecovery.save())
        if (tags) writes.push(await tagRecovery.save())
        const result = await window.electronAPI!.libraryEditing.commit({ scope, writes })
        if (!boundary.current.alive || key !== boundary.current.key) return false
        if (!result.ok) throw Error(result.message)
        if (notes) noteRecovery.acceptCommit(result)
        if (tags) tagRecovery.acceptCommit(result)
        setSaveWarning(result.warning ?? '')
      } else {
        const result = await onUpdate({
        arxivId: paper.arxivId,
        ...(notes ? { notes: noteText } : {}),
        ...(tags ? { tags: tagText.split(',').map(t => t.trim()).filter(Boolean) } : {})
      })
      if (!result.ok) { setSaveError(result.message || '保存失败，输入已保留'); return false }
      }
      if (notes) setEditingNotes(false)
      if (tags) setEditingTags(false)
      return true
    } catch (failure) {
      if (!boundary.current.alive || key !== boundary.current.key) return false
      setSaveError(failure instanceof Error ? failure.message : '保存失败，输入已保留')
      return false
    } finally { savingRef.current = false; setSaving(false) }
  }
  usePaperEditGuard({ isDirty: () => notesDirty || tagsDirty, isBusy: () => savingRef.current || togglingProject,
    save: () => persist('all'), discard })

  async function fallback() {
    if (!scope || savingRef.current || noteRecovery.existing.length || tagRecovery.existing.length) return
    savingRef.current = true; setSaving(true); setSaveError('')
    const key = boundary.current.key
    try {
      await Promise.all([noteRecovery.pause(), tagRecovery.pause()])
      if (!boundary.current.alive || key !== boundary.current.key) return
      const base = { ...(notesDirty ? noteRecovery.base : {}), ...(tagsDirty ? tagRecovery.base : {}) }
      const fields = { ...(notesDirty ? { notes: noteText } : {}), ...(tagsDirty ? { tags: tagText.split(',').map(t => t.trim()).filter(Boolean) } : {}) }
      const result = await window.electronAPI!.libraryEditing.saveWithoutRecovery({ scope, paperId: paper.arxivId, base, fields })
      if (!boundary.current.alive || key !== boundary.current.key) return
      if (!result.ok) throw Error(result.message)
      const reply = { paper: result.paper, state: 'saved' as const, cleanup: 'pending' as const, warning: '已使用普通保存；原恢复草稿保留，未声明恢复保护' }
      if (notesDirty) { noteRecovery.acceptCommit(reply); setEditingNotes(false) }
      if (tagsDirty) { tagRecovery.acceptCommit(reply); setEditingTags(false) }
      setSaveWarning(reply.warning)
    } catch (e) { setSaveError(e instanceof Error ? e.message : '保存失败，输入保留') }
    finally { savingRef.current = false; setSaving(false) }
  }
  async function cancelField(kind: 'notes' | 'tags') {
    try { if (scope) await (kind === 'notes' ? noteRecovery : tagRecovery).discard(); if (kind === 'notes') { setNoteText(paper.notes); setEditingNotes(false) } else { setTagText(paper.tags.join(', ')); setEditingTags(false) }; setSaveError('') }
    catch (e) { setSaveError(e instanceof Error ? e.message : '丢弃失败，输入保留') }
  }

  const toggleProject = async (projectId: string) => {
    if (savingRef.current) return
    if (projectId === selectedProjectId && paper.projectIds.includes(projectId) && !await requestEvidenceLeave()) return
    if (savingRef.current) return
    savingRef.current = true
    setTogglingProject(true); setSaveError('')
    try {
      const next = paper.projectIds.includes(projectId)
        ? paper.projectIds.filter((id) => id !== projectId)
        : [...paper.projectIds, projectId]
      const result = await onUpdate({ arxivId: paper.arxivId, projectIds: next })
      if (!result.ok) setSaveError(result.message || '关联更新失败')
    } catch (failure) {
      setSaveError(failure instanceof Error ? failure.message : '关联更新失败')
    } finally {
      savingRef.current = false
      setTogglingProject(false)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      await onDownloadPdf(paper.arxivId)
    } finally {
      setDownloading(false)
    }
  }

  const handleScore = async () => {
    setScoring(true)
    try {
      await onScoreRelevance(paper)
    } finally {
      setScoring(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      await onExportBib(paper)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className={cn(
        'group rounded-lg border bg-card p-3 transition-all',
        expanded ? 'border-primary/30 shadow-sm' : 'border-border hover:border-primary/20 hover:shadow-sm'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex items-start gap-2 flex-1 min-w-0 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="mt-0.5 text-muted-foreground shrink-0">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-[13px] leading-snug group-hover:text-primary transition-colors">
                {paper.title}
              </h3>
              {relevance && (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
                    relevance.score >= 7
                      ? 'bg-green-500/15 text-green-600'
                      : relevance.score >= 4
                        ? 'bg-yellow-500/15 text-yellow-600'
                        : 'bg-muted text-muted-foreground'
                  )}
                  title={relevance.reason || 'AI 相关性评分'}
                >
                  {relevance.score}/10
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1 truncate">
                <Users className="h-3 w-3 shrink-0" />
                <span className="truncate">{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}</span>
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <Calendar className="h-3 w-3" />
                入库：{formatDate(paper.addedAt)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {paperDateLabels(paper.dates).length === 0
                ? <span>来源日期：未知</span>
                : paperDateLabels(paper.dates).map(date => <span key={date.text} title={date.title}>{date.text}</span>)}
            </div>
            {!expanded && (
              <p className="text-[11px] text-muted-foreground/70 mt-1.5 line-clamp-2 leading-relaxed">
                {paper.summary}
              </p>
            )}
            {(paper.tags.length > 0 || paper.projectIds.length > 0) && (
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                {paper.tags.map((tag) => (
                  <span key={tag} className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    <Tag className="h-2.5 w-2.5" />
                    {tag}
                  </span>
                ))}
                {paper.projectIds.map((pid) => {
                  const project = projects.find((p) => p.id === pid)
                  if (!project) return null
                  return (
                    <span key={pid} className="flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                      <Folder className="h-2.5 w-2.5" />
                      {project.title}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleDownload}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title={paper.pdfPath ? '重新下载 PDF' : '下载 PDF'}
              disabled={downloading}
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : paper.pdfPath ? (
                <File className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <FileDown className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() => onOpenPdf(paper)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="内嵌阅读 PDF"
              disabled={!paper.pdfPath}
            >
              <BookOpen className="h-3.5 w-3.5" />
            </button>
            {onEvidence && <button onClick={() => onEvidence(paper)} title="证据卡" aria-label={`证据卡：${paper.title}`} className="flex h-6 items-center rounded px-1 text-xs text-primary hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><FileText className="mr-1 h-3.5 w-3.5" />证据</button>}
            <button
              onClick={() => onOpenExternal(paper.url)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title="打开原文"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onHandoffToAgent?.(paper)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-primary transition-colors"
              title="交给 Agent（在对话中引用本篇文献）"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onRemove(paper.arxivId)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:text-destructive transition-colors"
              title="从文献库移除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-primary"
              onClick={handleScore}
              disabled={scoring || !selectedProjectId}
              title={selectedProjectId ? 'AI 评估与当前项目的相关性' : '请先选择项目'}
            >
              {scoring ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
              AI 评分
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-primary"
              onClick={handleExport}
              disabled={exporting || !selectedProjectId}
              title={selectedProjectId ? '加入项目 references.bib' : '请先选择项目'}
            >
              {exporting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <FileText className="h-3 w-3 mr-1" />}
              BibTeX
            </Button>
          </div>
        </div>
      </div>

      {saveError && <p role="alert" className="mt-2 text-xs text-destructive whitespace-pre-wrap">{saveError}</p>}
      {saveWarning && <p role="status" className="mt-2 text-xs whitespace-pre-wrap">{saveWarning}</p>}
      {scope && (noteRecovery.error || tagRecovery.error) && <p role="alert" className="text-xs whitespace-pre-wrap">{noteRecovery.error || tagRecovery.error} · 暂存未完成，当前输入保留，可复制或显式普通保存。</p>}
      {scope && (saveError || noteRecovery.error || tagRecovery.error) && <div className="flex flex-wrap gap-2">{notesDirty && <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(noteText).then(() => setSaveWarning('已复制当前笔记输入'), () => setSaveError('复制失败，输入保留')) }}>复制当前笔记输入</Button>}{tagsDirty && <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(tagText).then(() => setSaveWarning('已复制当前标签输入'), () => setSaveError('复制失败，输入保留')) }}>复制当前标签输入</Button>}</div>}
      {scope && (saveError || noteRecovery.error || tagRecovery.error) && !noteRecovery.existing.length && !tagRecovery.existing.length && (notesDirty || tagsDirty) && <Button disabled={saving} variant="outline" onClick={() => void fallback()}>不使用恢复保护保存当前修改</Button>}
      {scope && [noteRecovery, tagRecovery].some(r => r.status === 'saved') && <p role="status" className="text-xs">恢复草稿已暂存（尚未正式保存文献）</p>}
      {saving && <p role="status" className="mt-2 text-xs text-muted-foreground">保存中…</p>}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-border space-y-3">
          <p className="text-[12px] text-muted-foreground leading-relaxed">{paper.summary}</p>

          {relevance && (
            <div className="rounded-md bg-muted/50 p-2 text-[11px]">
              <span className="font-medium text-muted-foreground">AI 相关性：{relevance.score}/10</span>
              {relevance.reason && <p className="mt-0.5 text-muted-foreground/80 leading-relaxed">{relevance.reason}</p>}
            </div>
          )}

          {/* 标签编辑 */}
          {scope && editingTags && tagRecovery.existing.length > 0 && <PaperDraftChoices scope={scope} existing={tagRecovery.existing} current={{ tags: paper.tags }} onRestore={tagRecovery.restore} onDiscard={tagRecovery.discardExisting} />}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">标签</span>
              {!editingTags && (
                <button disabled={saving || togglingProject} onClick={() => { setSaveError(''); setEditingTags(true); setTagText(paper.tags.join(', ')) }} className="text-[10px] text-primary hover:underline">
                  {paper.tags.length > 0 ? '编辑' : '添加标签'}
                </button>
              )}
            </div>
            {editingTags ? (
              <div className="flex gap-1.5">
                <Input
                  disabled={saving || togglingProject}
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  placeholder="逗号分隔，如 survey, llm"
                  className="h-7 text-[11px] flex-1"
                  autoFocus
                  onKeyDown={(e) => isSubmitEnter(e) && void persist('tags')}
                />
                <Button disabled={saving || togglingProject} size="sm" className="h-7 text-[10px]" onClick={() => void persist('tags')}>保存</Button>
                <Button disabled={saving || togglingProject} size="sm" variant="ghost" className="h-7 text-[10px]" onClick={() => void cancelField('tags')}>取消</Button>
              </div>
            ) : (
              paper.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {paper.tags.map((tag) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                  ))}
                </div>
              )
            )}
          </div>

          {/* 项目关联 */}
          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">关联项目</span>
            <div className="flex flex-wrap gap-1">
              {projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => toggleProject(project.id)}
                    disabled={togglingProject || saving}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                    paper.projectIds.includes(project.id)
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground hover:bg-muted/70'
                  )}
                >
                  {project.title}
                </button>
              ))}
            </div>
          </div>

          {/* 阅读笔记 */}
          {scope && editingNotes && noteRecovery.existing.length > 0 && <PaperDraftChoices scope={scope} existing={noteRecovery.existing} current={{ notes: paper.notes }} onRestore={noteRecovery.restore} onDiscard={noteRecovery.discardExisting} />}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">阅读笔记</span>
              {!editingNotes && (
                <button disabled={saving || togglingProject} onClick={() => { setSaveError(''); setEditingNotes(true); setNoteText(paper.notes) }} className="text-[10px] text-primary hover:underline">
                  {paper.notes ? '编辑' : '添加笔记'}
                </button>
              )}
            </div>
            {editingNotes ? (
              <div className="space-y-1.5">
                <Textarea
                  disabled={saving || togglingProject}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="写下你的阅读笔记..."
                  className="min-h-[80px] text-[12px] resize-none"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Button disabled={saving || togglingProject} size="sm" className="h-6 text-[10px]" onClick={() => void persist('notes')}>保存</Button>
                  <Button disabled={saving || togglingProject} size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => void cancelField('notes')}>取消</Button>
                </div>
              </div>
            ) : (<>
              {plainNotes && <p className="text-[11px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap">{plainNotes}</p>}
              {readingNotes.length > 0 && (
                <div className="space-y-2">
                  {readingNotes.map((note, index) => (
                    <div key={index} className="rounded-md bg-muted/40 p-2">
                      <span className="text-[9px] text-muted-foreground/60">{note.at}</span>
                      <p className="text-[11px] text-muted-foreground/90 leading-relaxed whitespace-pre-wrap mt-0.5">{note.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </>)}
          </div>

          {paper.pdfPath && (
            <div className="flex items-center gap-2 text-[11px] text-green-600">
              <File className="h-3 w-3" />
              <span className="truncate">{paper.pdfPath}</span>
              <button onClick={() => onOpenPdf(paper)} className="underline hover:text-green-700 shrink-0">内嵌阅读</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
