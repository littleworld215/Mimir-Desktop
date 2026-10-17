import { useEffect, useRef, useState } from 'react'
import { X, Maximize2, Minimize2, BookOpen, ExternalLink, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { PaperRecord } from './types'
import { pdfUrlOf, parseReadingNotes, appendReadingNote } from './types'
import { requestEvidenceLeave } from '@/lib/evidenceEditGuard'
import { EvidencePanel, evidenceSourceLabels } from './evidence/EvidencePanel'
import type { ProjectRecord } from './types'
import type { SourceOpenResult } from '../../../../shared/libraryEvidenceContracts'

interface PaperReaderProps {
  paper: PaperRecord
  onClose: () => void
  onUpdateNotes: (arxivId: string, notes: string) => Promise<void>
  onOpenExternal: (url: string) => void
  initialTab?: 'notes' | 'evidence'
  projectId?: string
  papers?: PaperRecord[]
  projects?: ProjectRecord[]
}

export function PaperReader({ paper, onClose, onUpdateNotes, onOpenExternal, initialTab = 'notes', projectId, papers, projects }: PaperReaderProps) {
  const [fullscreen, setFullscreen] = useState(false)
  const [addingNote, setAddingNote] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState(initialTab), [pdfUrl, setPdfUrl] = useState(pdfUrlOf(paper.arxivId)), [source, setSource] = useState<SourceOpenResult>()
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    container.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  async function close() { if (await requestEvidenceLeave()) onClose() }
  async function changeTab(next: 'notes' | 'evidence') { if (tab !== next && await requestEvidenceLeave()) setTab(next) }

  const readingNotes = parseReadingNotes(paper.notes)

  const saveNote = async () => {
    if (!noteText.trim() || saving) return
    setSaving(true)
    try {
      const next = appendReadingNote(paper.notes, noteText, new Date())
      await onUpdateNotes(paper.arxivId, next)
      setNoteText('')
      setAddingNote(false)
    } finally {
      setSaving(false)
    }
  }

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
        'fixed inset-0 z-40 flex flex-col bg-background',
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
        <div className="flex-1 min-w-0 bg-muted/30">
          {paper.pdfPath ? <iframe
            src={pdfUrl}
            className="h-full w-full"
            title={paper.title}
          /> : <p className="p-4 text-sm text-muted-foreground">尚无本地PDF，可先整理证据草稿。</p>}
        </div>

        {/* 阅读笔记侧栏 */}
        <div className={cn('shrink-0 border-l border-border bg-card flex flex-col min-h-0 min-w-0', tab === 'evidence' ? 'w-[52%] min-w-[300px]' : 'w-72')}>
          <div role="tablist" aria-label="文献阅读侧栏" className="flex gap-2 border-b border-border px-3 py-2"><button role="tab" aria-selected={tab === 'notes'} onClick={() => void changeTab('notes')} className="rounded px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring">阅读笔记</button><button role="tab" aria-selected={tab === 'evidence'} onClick={() => void changeTab('evidence')} className="rounded px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring">证据卡</button></div>
          {tab === 'evidence' ? <div className="min-h-0 flex-1 overflow-y-auto"><EvidencePanel paperId={paper.arxivId} projectId={projectId} papers={papers} projects={projects} onOpenSource={result => { setSource(result); if (result.pdfUrl) setPdfUrl(result.pdfUrl) }} /></div> : <>
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span className="text-[11px] font-medium text-muted-foreground">阅读笔记</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px] text-primary hover:text-primary"
              onClick={() => setAddingNote(true)}
            >
              <Plus className="h-3 w-3 mr-0.5" />
              添加
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {addingNote && (
              <div className="space-y-1.5">
                <Textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="记录阅读心得、关键公式、待办..."
                  className="min-h-[100px] text-[12px] resize-none"
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-6 text-[10px]" onClick={saveNote} disabled={saving || !noteText.trim()}>
                    {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setAddingNote(false)}>
                    取消
                  </Button>
                </div>
              </div>
            )}
            {readingNotes.length === 0 && !addingNote && (
              <p className="text-[11px] text-muted-foreground/60">暂无阅读笔记。阅读时记录要点，笔记会自动带时间戳。</p>
            )}
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
