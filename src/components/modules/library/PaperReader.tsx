import { useEffect, useRef, useState, type ComponentType } from 'react'
import { X, Maximize2, Minimize2, BookOpen, ExternalLink, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { PaperRecord, PaperSaveResult } from './types'
import { usePaperEditGuard } from './usePaperEditGuard'
import { pdfUrlOf, readingNotesView, appendReadingNote } from './types'
import { requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import { EvidencePanel, evidenceSourceLabels } from './evidence/EvidencePanel'
import type { ProjectRecord } from './types'
import type { SourceOpenResult } from '../../../../shared/libraryEvidenceContracts'
import type { EditingDraft, EditingScope } from '../../../../shared/libraryEditingContracts'
import { usePaperRecoveryDraft } from './usePaperRecoveryDraft'
import { PaperDraftChoices } from './PaperDraftRecovery'
import type { LibraryReadingPosition } from '@/lib/libraryBrowseState'
import type { EnhancedPdfReaderProps } from './EnhancedPdfReader'
import type { PdfExcerpt } from '@/lib/pdfReaderTypes'

interface PaperReaderProps {
  scope?: EditingScope
  onConfirmedPaper?: (paper: PaperRecord) => void
  recoverySelection?: EditingDraft
  paper: PaperRecord
  onClose: () => void
  onUpdateNotes: (arxivId: string, notes: string) => Promise<PaperSaveResult>
  onOpenExternal: (url: string) => void
  initialTab?: 'notes' | 'evidence'
  projectId?: string
  papers?: PaperRecord[]
  projects?: ProjectRecord[]
  initialReadingPosition?: LibraryReadingPosition
  onReadingPositionChange?(position: LibraryReadingPosition): void
}

export function PaperReader({ scope, onConfirmedPaper, recoverySelection, paper, onClose, onUpdateNotes, onOpenExternal, initialTab = 'notes', projectId, papers, projects, initialReadingPosition, onReadingPositionChange }: PaperReaderProps) {
  const [fullscreen, setFullscreen] = useState(false)
  const [addingNote, setAddingNote] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveWarning, setSaveWarning] = useState('')
  const savingRef = useRef(false)
  const boundary = useRef({ alive: true, key: '' })
  boundary.current.key = `${scope?.workspaceId}:${scope?.spaceEpoch}:${paper.arxivId}`
  useEffect(() => { boundary.current.alive = true; return () => { boundary.current.alive = false } }, [])
  useEffect(() => { savingRef.current = false; setSaving(false) }, [scope?.workspaceId, scope?.spaceEpoch, paper.arxivId])
  const [tab, setTab] = useState(initialTab), [pdfUrl, setPdfUrl] = useState(pdfUrlOf(paper.arxivId)), [source, setSource] = useState<SourceOpenResult>()
  const [readerMode, setReaderMode] = useState<'native' | 'enhanced'>('native')
  const [EnhancedReader, setEnhancedReader] = useState<ComponentType<EnhancedPdfReaderProps>>()
  const [readerLoadError, setReaderLoadError] = useState(''), [readerAttempt, setReaderAttempt] = useState(0)
  const [readerPosition, setReaderPosition] = useState(initialReadingPosition?.paperId === paper.arxivId ? initialReadingPosition : undefined)
  const sourceIdentity = JSON.stringify([scope?.workspaceId, scope?.spaceEpoch, paper.arxivId, paper.pdfPath])
  const previousSource = useRef(sourceIdentity)
  const [pendingExcerpt, setPendingExcerpt] = useState<PdfExcerpt>()
  async function receiveExcerpt(excerpt: PdfExcerpt) {
    if (!scope || excerpt.paperId !== paper.arxivId || excerpt.scope.workspaceId !== scope.workspaceId || excerpt.scope.spaceEpoch !== scope.spaceEpoch) return
    setPendingExcerpt(excerpt)
    const key = boundary.current.key
    if (tab !== 'evidence' && await requestEvidenceLeave() && boundary.current.alive && boundary.current.key === key) setTab('evidence')
  }
  useEffect(() => {
    if (previousSource.current === sourceIdentity) return
    previousSource.current = sourceIdentity
    setReaderMode('native'); setReaderPosition(undefined); setPdfUrl(pdfUrlOf(paper.arxivId)); setSource(undefined); setPendingExcerpt(undefined)
  }, [sourceIdentity])
  useEffect(() => {
    if (readerMode !== 'enhanced' || EnhancedReader) return
    let alive = true
    setReaderLoadError('')
    void import('./EnhancedPdfReader').then(module => { if (alive) setEnhancedReader(() => module.EnhancedPdfReader) }, () => { if (alive) setReaderLoadError('增强阅读组件加载失败，当前输入保留，可重试或返回原阅读。') })
    return () => { alive = false }
  }, [readerMode, EnhancedReader, readerAttempt])
  async function changeReaderMode(next: 'native' | 'enhanced') {
    if (readerMode !== next && await requestEvidenceLeave()) setReaderMode(next)
  }
  const container = useRef<HTMLDivElement>(null)
  const recovery = usePaperRecoveryDraft({ scope: addingNote ? scope : undefined, paperId: paper.arxivId, kind: 'append', base: { notes: paper.notes }, input: noteText, onRestore: setNoteText, onConfirmedPaper })
  useEffect(() => { if (recoverySelection) { setAddingNote(true); setTab('notes') } }, [recoverySelection?.id])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    container.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  async function close() { if (await requestEvidenceLeave()) onClose() }
  async function changeTab(next: 'notes' | 'evidence') { if (tab !== next && await requestEvidenceLeave()) setTab(next) }

  const { plain: plainNotes, entries: readingNotes } = readingNotesView(paper.notes)

  const saveNote = async (): Promise<boolean> => {
    if (savingRef.current) return false
    if (!scope && !noteText.trim()) return true
    savingRef.current = true
    const key = boundary.current.key
    setSaving(true); setSaveError('')
    let pending: Awaited<ReturnType<typeof recovery.save>> | undefined
    try {
      if (scope) {
        pending = await recovery.save()
        const result = await window.electronAPI!.libraryEditing.commit({ scope, writes: [pending] })
        if (!boundary.current.alive || key !== boundary.current.key) return false
        if (!result.ok) throw Error(result.message)
        recovery.acceptCommit(result); setSaveWarning(result.warning ?? '')
      } else {
        const next = appendReadingNote(paper.notes, noteText, new Date())
        const result = await onUpdateNotes(paper.arxivId, next)
        if (!result.ok) { setSaveError(result.message || '保存失败，输入已保留'); return false }
      }
      setNoteText('')
      setAddingNote(false)
      return true
    } catch (failure) {
      if (!boundary.current.alive || key !== boundary.current.key) return false
      if (pending) await recovery.commitFailed(pending)
      if (!boundary.current.alive || key !== boundary.current.key) return false
      setSaveError(failure instanceof Error ? failure.message : '保存失败，输入已保留')
      return false
    } finally {
      if (boundary.current.alive && key === boundary.current.key) { savingRef.current = false; setSaving(false) }
    }
  }

  async function discard() {
    if (savingRef.current) throw Error('正在处理编辑，请稍候')
    const key = boundary.current.key, current = () => boundary.current.alive && key === boundary.current.key
    savingRef.current = true; setSaving(true)
    try {
      if (scope) await recovery.discard()
      if (!current()) throw Error('SPACE_CHANGED：编辑会话已变化')
      setNoteText(''); setAddingNote(false); setSaveError('')
    } catch (e) { if (current()) setSaveError(e instanceof Error ? e.message : '丢弃失败'); throw e }
    finally { if (current()) { savingRef.current = false; setSaving(false) } }
  }
  async function fallback() {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true)
    try { const saved = await recovery.saveWithoutRecovery(); if (!saved) return; setSaveWarning('已使用普通保存；原恢复草稿保留，未声明恢复保护'); setSaveError(''); setNoteText(''); setAddingNote(false) }
    catch (e) { setSaveError(e instanceof Error ? e.message : '保存失败，输入保留') }
    finally { savingRef.current = false; setSaving(false) }
  }
  usePaperEditGuard({ isDirty: () => addingNote && noteText !== '', isBusy: () => savingRef.current,
    save: saveNote, discard })

  return (
    <div
      ref={container} role="dialog" aria-label="文献阅读器" aria-modal="true" tabIndex={-1}
      onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.stopPropagation(); void close() }
        if (e.key === 'Tab') {
          const controls = container.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')
          const first = controls?.[0], last = controls?.[controls.length - 1]
          if (e.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}
      className={cn(
        'fixed inset-0 z-40 flex flex-col bg-background text-foreground',
        fullscreen ? 'z-50' : 'm-4 rounded-lg border border-border shadow-2xl overflow-hidden'
      )}
    >
      {/* 阅读器工具栏 */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 shrink-0">
        <BookOpen className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium truncate">{paper.title}</p>
          <p className="text-[10px] text-muted-foreground truncate">{paper.authors.slice(0, 3).join(', ')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setFullscreen(!fullscreen)}
          title={fullscreen ? '退出全屏' : '全屏'}
        >
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => onOpenExternal(paper.url)}
          title="打开原文"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => void close()}
          title="关闭"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {source && <p role="status" className="border-b border-border p-2 text-xs break-words">{evidenceSourceLabels[source.status]} · PDF物理页 {source.requestedPage ?? '未填写'} · 请按页码定位；未自动确认跳转位置。</p>}
      <div className="flex flex-1 min-h-0">
        {/* PDF 区域 */}
        <div className="flex-1 min-w-0 min-h-0 bg-muted/30 flex flex-col">
          {paper.pdfPath && <div className="flex flex-wrap gap-2 border-b border-border p-2 text-xs">
            <button aria-pressed={readerMode === 'native'} className="rounded border px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void changeReaderMode('native')}>原阅读</button>
            <button aria-pressed={readerMode === 'enhanced'} disabled={!scope} className="rounded border px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void changeReaderMode('enhanced')}>增强阅读</button>
            {pendingExcerpt && tab !== 'evidence' && <button className="rounded border px-2 py-1" onClick={() => void changeTab('evidence')}>查看待接收PDF摘录</button>}
          </div>}
          {paper.pdfPath && readerMode === 'enhanced' && scope ? <div className="min-h-0 flex-1">
            {readerLoadError ? <div className="p-3 text-sm"><p role="alert">{readerLoadError}</p><button className="rounded border px-2 py-1" onClick={() => setReaderAttempt(value => value + 1)}>重试加载增强阅读</button></div>
              : EnhancedReader ? <EnhancedReader key={sourceIdentity} scope={scope} paperId={paper.arxivId} url={pdfUrl}
                initialPage={readerPosition?.mode === 'enhanced' ? readerPosition.page : undefined} initialScale={readerPosition?.scale}
                onPosition={position => { const next: LibraryReadingPosition = { ...position, mode: 'enhanced', paperId: paper.arxivId, touchedAt: Date.now() }; setReaderPosition(next); onReadingPositionChange?.(next) }} onExcerpt={excerpt => void receiveExcerpt(excerpt)} />
                : <p role="status" className="p-3 text-sm">正在加载增强阅读组件…</p>}
          </div> : paper.pdfPath ? <iframe
            src={pdfUrl}
            className="min-h-0 flex-1 w-full"
            title={paper.title}
          /> : <p className="p-4 text-sm text-muted-foreground">尚无本地PDF，可先整理证据草稿。</p>}
        </div>

        {/* 阅读笔记侧栏 */}
        <div className={cn('shrink-0 border-l border-border bg-card flex flex-col min-h-0 min-w-0', tab === 'evidence' ? 'w-[52%] min-w-[300px]' : 'w-72')}>
          <div role="tablist" aria-label="文献阅读侧栏" className="flex gap-2 border-b border-border px-3 py-2"><button role="tab" aria-selected={tab === 'notes'} onClick={() => void changeTab('notes')} className="rounded px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring">阅读笔记</button><button role="tab" aria-selected={tab === 'evidence'} onClick={() => void changeTab('evidence')} className="rounded px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring">证据卡</button></div>
          {tab === 'evidence' ? <div className="min-h-0 flex-1 overflow-y-auto"><EvidencePanel paperId={paper.arxivId} projectId={projectId} scope={scope} papers={papers} projects={projects} excerpt={pendingExcerpt} onExcerptAccepted={id => setPendingExcerpt(previous => previous?.id === id ? undefined : previous)} onOpenSource={result => { setSource(result); if (result.pdfUrl) setPdfUrl(result.pdfUrl) }} /></div> : <>
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span className="text-[11px] font-medium text-muted-foreground">阅读笔记</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px] text-primary hover:text-primary"
              disabled={saving || addingNote}
              onClick={() => { setSaveError(''); setAddingNote(true) }}
            >
              <Plus className="h-3 w-3 mr-0.5" />
              添加
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {saveError && <p role="alert" className="text-xs text-destructive whitespace-pre-wrap">{saveError}</p>}
            {saveWarning && <p role="status" className="text-xs whitespace-pre-wrap">{saveWarning}</p>}
            {scope && recovery.error && <p role="alert" className="text-xs whitespace-pre-wrap">{recovery.error} · 暂存未完成，当前输入保留。</p>}
            {scope && (saveError || recovery.error) && addingNote && <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(noteText).then(() => setSaveWarning('已复制当前追加输入'), () => setSaveError('复制失败，输入保留')) }}>复制当前追加输入</Button>}
            {scope && recovery.status === 'saved' && <p role="status" className="text-xs">恢复草稿已暂存（尚未正式保存文献）</p>}
            {scope && addingNote && recovery.existing.length > 0 && <PaperDraftChoices scope={scope} existing={recovery.existing} current={{ notes: paper.notes }} onRestore={recovery.restore} onDiscard={recovery.discardExisting} />}
            {scope && (saveError || recovery.error) && addingNote && !recovery.existing.length && <Button disabled={saving} variant="outline" onClick={() => void fallback()}>不使用恢复保护保存当前修改</Button>}
            {addingNote && (
              <div className="space-y-1.5">
                <Textarea
                  disabled={saving}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="记录阅读心得、关键公式、待办..."
                  className="min-h-[100px] text-[12px] resize-none"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-6 text-[10px]" onClick={saveNote} disabled={saving || (!scope && !noteText.trim())}>
                    {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    保存
                  </Button>
                  <Button disabled={saving} size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => void discard().catch(() => {})}>
                    取消
                  </Button>
                </div>
              </div>
            )}
            {readingNotes.length === 0 && !plainNotes && !addingNote && (
              <p className="text-[11px] text-muted-foreground/60">暂无阅读笔记。阅读时记录要点，笔记会自动带时间戳。</p>
            )}
            {plainNotes && <p className="text-[11px] text-muted-foreground/90 leading-relaxed whitespace-pre-wrap">{plainNotes}</p>}
            {readingNotes.map((note, index) => (
              <div key={index} className="rounded-md bg-muted/40 p-2">
                <span className="text-[9px] text-muted-foreground/60">{note.at}</span>
                <p className="text-[11px] text-muted-foreground/90 leading-relaxed whitespace-pre-wrap mt-0.5">{note.text}</p>
              </div>
            ))}
          </div>
          </>}
        </div>
      </div>
    </div>
  )
}
