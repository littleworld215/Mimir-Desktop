import { useEffect, useRef, useState } from 'react'
import type { CommitReply, DraftSummary, EditingDraft, EditingFields, EditingKind, EditingScope, SessionWrite } from '../../../../shared/libraryEditingContracts'
import type { PaperRecord } from './types'

interface Options { scope?: EditingScope; paperId: string; kind: EditingKind; base: EditingFields; input: string; onRestore(input: string): void; onConfirmedPaper?(paper: PaperRecord): void }
type Session = { id: string; revision: number; sequence: number; base: EditingFields; scope: EditingScope; alive: boolean; stopped: boolean; savedInput: string; draft?: EditingDraft; due: boolean; flight?: Promise<void> }
export function usePaperRecoveryDraft(options: Options) {
  const latest = useRef(options); latest.current = options
  const session = useRef<Session>(), generation = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>()
  const previousIdentity = useRef<string>()
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const [existing, setExisting] = useState<DraftSummary[]>([]), [error, setError] = useState(''), [warning, setWarning] = useState(''), [ready, setReady] = useState(0)
  const api = () => window.electronAPI?.libraryEditing
  const live = (s: Session) => s.alive && session.current === s
  function fail(e: unknown) { const message = e instanceof Error ? e.message : '恢复草稿操作失败，当前输入保留'; setError(message); setStatus(message.includes('CONFLICT') || message.includes('SPACE_CHANGED') ? 'conflict' : 'error') }
  function stopTimer() { if (timer.current) clearTimeout(timer.current); timer.current = undefined }
  function close(s: Session) { s.alive = false; s.stopped = true; void api()?.close({ scope: s.scope, sessionId: s.id }).catch(() => {}) }
  function acceptOpen(result: { base: EditingFields; sessionId?: string; revision: number; existing: DraftSummary[] }, scope: EditingScope, restored?: EditingDraft, initialInput?: string) {
    setExisting(restored ? [] : result.existing)
    if (result.sessionId) session.current = { id: result.sessionId, revision: result.revision, sequence: 0, base: result.base, scope, alive: true, stopped: false, savedInput: restored?.input ?? initialInput ?? (latest.current.kind === 'tags' ? result.base.tags?.join(', ') ?? '' : latest.current.kind === 'append' ? '' : result.base.notes ?? ''), draft: restored, due: false }
    setStatus('idle'); setError(''); setReady(n => n + 1)
  }
  useEffect(() => {
    const epoch = ++generation.current, scope = options.scope
    stopTimer(); const old = session.current; if (old) close(old); session.current = undefined
    setExisting([]); setError(''); setStatus('idle'); setWarning('')
    if (!scope) return
    const identity = JSON.stringify([scope.workspaceId, scope.spaceEpoch, options.paperId]), changed = previousIdentity.current !== undefined && previousIdentity.current !== identity
    const initialInput = changed ? latest.current.input : undefined
    previousIdentity.current = identity
    const bridge = api()
    if (!bridge) { fail(Error('恢复保护不可用；输入保留，可复制或显式选择普通保存')); return }
    void bridge.open({ scope, paperId: options.paperId, kind: options.kind }).then(result => {
      if (epoch !== generation.current) { if (result.ok && result.sessionId) void bridge.close({ scope, sessionId: result.sessionId }).catch(() => {}); return }
      if (!result.ok) { fail(Error(result.message)); return }
      acceptOpen(result, scope, undefined, initialInput)
    }).catch(e => { if (epoch === generation.current) fail(e) })
    return () => { ++generation.current; stopTimer(); const s = session.current; if (s) close(s); session.current = undefined }
  }, [options.scope?.workspaceId, options.scope?.spaceEpoch, options.paperId, options.kind])

  async function pump(): Promise<void> {
    const s = session.current, bridge = api()
    if (!s || !bridge || s.stopped) throw Error('请先处理恢复草稿选择，或检查恢复保护是否可用')
    if (s.flight) return s.flight
    s.flight = (async () => {
      while (live(s) && !s.stopped && s.due) {
        s.due = false; const input = latest.current.input
        if (input === s.savedInput) continue
        setStatus('saving'); setError('')
        const result = await bridge.saveDraft({ scope: s.scope, write: { sessionId: s.id, expectedRevision: s.revision, sequence: ++s.sequence, input } })
        if (!live(s)) return
        if (!result.ok) throw Error(result.message)
        s.revision = result.draft.revision; s.draft = result.draft; s.savedInput = input
        setStatus('saved')
      }
    })().catch(e => { if (live(s)) fail(e); throw e }).finally(() => { s.flight = undefined })
    return s.flight
  }
  useEffect(() => {
    stopTimer(); const s = session.current
    if (!s || s.stopped || options.input === s.savedInput) return
    timer.current = setTimeout(() => { s.due = true; void pump().catch(() => {}) }, 500)
    return stopTimer
  }, [options.input, ready])

  async function save(): Promise<SessionWrite> {
    stopTimer(); const s = session.current
    if (!s || s.stopped || existing.length) throw Error('请先恢复或明确丢弃已有草稿；当前输入保留')
    s.due = true; await pump()
    if (!live(s)) throw Error('编辑会话已结束，当前输入保留')
    return { sessionId: s.id, expectedRevision: s.revision, sequence: s.sequence + 1, input: latest.current.input }
  }
  async function discard() {
    stopTimer(); const s = session.current, bridge = api()
    if (!s) { if (existing.length) throw Error('请先选择需要丢弃的恢复草稿'); return }
    s.stopped = true; s.due = false
    try {
      await s.flight?.catch(() => {})
      if (!live(s)) throw Error('编辑会话已结束')
      const result = s.draft ? await bridge!.discard({ scope: s.scope, id: s.draft.id, revision: s.draft.revision }) : await bridge!.close({ scope: s.scope, sessionId: s.id })
      if (!result.ok) throw Error(result.message)
      close(s); session.current = undefined; setStatus('idle'); setError('')
    } catch (e) { fail(e); throw e }
  }
  async function restore(draft: EditingDraft) {
    const bridge = api(), scope = latest.current.scope
    if (!bridge || !scope) throw Error('恢复保护不可用')
    stopTimer(); const epoch = ++generation.current, old = session.current; if (old) close(old); session.current = undefined
    try {
      const result = await bridge.open({ scope, paperId: latest.current.paperId, kind: latest.current.kind, resume: { draftId: draft.id, revision: draft.revision } })
      if (epoch !== generation.current) { if (result.ok && result.sessionId) void bridge.close({ scope, sessionId: result.sessionId }).catch(() => {}); return }
      if (!result.ok) throw Error(result.message)
      acceptOpen(result, scope, draft); latest.current.onRestore(draft.input)
    } catch (e) { if (epoch === generation.current) fail(e); throw e }
  }
  async function discardExisting(draft: EditingDraft) {
    const bridge = api(), scope = latest.current.scope, epoch = generation.current
    if (!bridge || !scope) throw Error('恢复保护不可用')
    try {
      const result = await bridge.discard({ scope, id: draft.id, revision: draft.revision })
      if (!result.ok) throw Error(result.message)
      const opened = await bridge.open({ scope, paperId: latest.current.paperId, kind: latest.current.kind })
      if (epoch !== generation.current) { if (opened.ok && opened.sessionId) void bridge.close({ scope, sessionId: opened.sessionId }).catch(() => {}); return }
      if (!opened.ok) throw Error(opened.message)
      acceptOpen(opened, scope)
    } catch (e) { if (epoch === generation.current) fail(e); throw e }
  }
  function acceptCommit(reply: CommitReply) {
    stopTimer(); const s = session.current; if (s) close(s); session.current = undefined
    setExisting([]); setError(''); setStatus('idle'); setWarning(reply.warning ?? '')
    latest.current.onConfirmedPaper?.(reply.paper)
  }
  async function saveWithoutRecovery() {
    const bridge = api(), s = session.current, o = latest.current, epoch = generation.current
    if (!bridge || !o.scope || existing.length) throw Error('请先处理已有草稿')
    stopTimer(); if (s) { s.stopped = true; s.due = false; await s.flight?.catch(() => {}) }
    const result = await bridge.saveWithoutRecovery({ scope: o.scope, paperId: o.paperId, base: s?.base ?? o.base, ...(o.kind === 'append' ? { appendInput: o.input } : { fields: o.kind === 'tags' ? { tags: o.input.split(',').map(t => t.trim()).filter(Boolean) } : { notes: o.input } }) })
    if (!result.ok) { fail(Error(result.message)); throw Error(result.message) }
    if (epoch !== generation.current || (s && !live(s))) return
    if (s) close(s); session.current = undefined; setWarning('已使用普通保存；原恢复草稿保留，未声明恢复保护'); setStatus('idle'); setError(''); o.onConfirmedPaper?.(result.paper)
    return result.paper
  }
  async function pause() { stopTimer(); const s = session.current; if (s) { s.stopped = true; s.due = false; await s.flight?.catch(() => {}) } }
  const s = session.current
  return { status, existing, error, warning, write: s && !s.stopped ? { sessionId: s.id, expectedRevision: s.revision, sequence: s.sequence + 1, input: options.input } : null, base: s?.base ?? options.base, save, discard, restore, discardExisting, acceptCommit, saveWithoutRecovery, pause }
}
