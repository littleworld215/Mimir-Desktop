import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OperationScope } from '../workspaceBackup/operationGate'
import type { PaperRecord } from '../../shared/libraryPaperRecord'
import type { CommitReply, DraftSummary, EditingDocument, EditingDraft, EditingFields, EditingKind, EditingStatus, SessionWrite } from '../../shared/libraryEditingContracts'
import { appendReadingNote } from '../../shared/appendReadingNote'
import { createEditingRepository } from './repository'
import { EditingError, editingFieldsSchema, editingId, editingKindSchema, editingPaperId, editingRevision } from './validation'

export interface EditingContext { scope: OperationScope; assertCurrent(): void }
export interface EditingHost { readPaper(id: string): PaperRecord | undefined; updatePaper(request: { arxivId: string; notes?: string; tags?: string[] }): Promise<PaperRecord> }
export const sessionWriteSchema = z.object({ sessionId: editingId, expectedRevision: editingRevision, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), input: z.string() }).strict()
export const fallbackSchema = z.object({ paperId: editingPaperId, base: editingFieldsSchema, fields: editingFieldsSchema.optional(), appendInput: z.string().optional() }).strict().refine(r => r.appendInput === undefined ? !!r.fields : !r.fields && r.base.notes !== undefined && r.base.tags === undefined)
type Fallback = z.infer<typeof fallbackSchema>
type Session = { owner: number; scope: OperationScope; paperId: string; kind: EditingKind; base: EditingFields; draftId: string; revision: number; sequence: number; prepared?: SessionWrite; completed?: { key: string; reply: CommitReply; result: EditingFields; ids: string[]; commitId: string } }
const clone = <T>(v: T): T => structuredClone(v)
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const matches = (paper: PaperRecord, fields: EditingFields) => (fields.notes === undefined || fields.notes === paper.notes) && (fields.tags === undefined || equal(fields.tags, paper.tags))
const field = (kind: EditingKind) => kind === 'tags' ? 'tags' : 'notes'
const tagsOf = (text: string) => [...new Set(text.split(',').map(v => v.trim()).filter(Boolean))]
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => { const result = schema.safeParse(input); if (!result.success) throw new EditingError('BAD_REQUEST'); return result.data }

export function createEditingService({ repository = createEditingRepository(), host, now = () => new Date(), newId = randomUUID }: { repository?: ReturnType<typeof createEditingRepository>; host: EditingHost; now?: () => Date; newId?: () => string }) {
  const sessions = new Map<string, Session>(), busy = new Set<string>()
  function active(ctx: EditingContext, id: string) {
    ctx.assertCurrent(); const paper = host.readPaper(id)
    if (!paper || paper.removedAt) throw new EditingError('CONFLICT', paper ? '文献已在回收站，草稿仍可查看复制' : '文献已失联，草稿仍可查看复制')
    return paper
  }
  function session(ctx: EditingContext, owner: number, id: string) {
    ctx.assertCurrent(); const s = sessions.get(id)
    if (!s || s.owner !== owner) throw new EditingError('SESSION_CLOSED', '编辑会话已结束')
    if (!equal(s.scope, ctx.scope)) throw new EditingError('SPACE_CHANGED', '科研空间已变化')
    return s
  }
  function status(d: EditingDraft): EditingStatus {
    const p = host.readPaper(d.paperId)
    if (!p) return 'missing'
    if (p.removedAt) return 'trashed'
    if (d.intent && matches(p, d.intent.result)) return 'already-saved'
    return matches(p, d.intent?.base ?? d.base) ? 'editable' : 'conflict'
  }
  function summary(d: EditingDraft): DraftSummary { return { id: d.id, paperId: d.paperId, kind: d.kind, revision: d.revision, updatedAt: d.updatedAt, status: status(d) } }
  function publish(ctx: EditingContext, doc: EditingDocument, drafts: EditingDraft[]) { ctx.assertCurrent(); return repository.commit(ctx.scope.root, doc.revision, { schemaVersion: 1, revision: doc.revision + 1, drafts }, ctx.assertCurrent) }
  function checkWrite(ctx: EditingContext, owner: number, raw: SessionWrite, doc: EditingDocument) {
    const w = parse(sessionWriteSchema, raw), s = session(ctx, owner, w.sessionId)
    const exactPrepared = s.prepared && equal(s.prepared, w)
    if (s.completed || (!exactPrepared && (w.expectedRevision !== s.revision || w.sequence <= s.sequence))) throw new EditingError('CONFLICT', '编辑修订已变化')
    const d = doc.drafts.find(row => row.id === s.draftId)
    if (d ? d.revision !== s.revision : s.revision !== 0) throw new EditingError('CONFLICT', '恢复草稿已有更新')
    if (!matches(active(ctx, s.paperId), s.base)) throw new EditingError('CONFLICT', '文献内容已有更新，请先对照')
    return { w, s, d }
  }
  function clearIntents(drafts: EditingDraft[], ids: Set<string>, revision: number) {
    const commits = new Set(drafts.filter(d => ids.has(d.id)).map(d => d.intent?.commitId).filter(Boolean))
    return drafts.map(d => d.intent && commits.has(d.intent.commitId) ? { ...d, intent: undefined, revision } : d)
  }
  function cleanup(ctx: EditingContext, ids: string[], commitId: string): 'done' | 'pending' {
    try {
      ctx.assertCurrent(); const doc = repository.read(ctx.scope.root)
      if (!doc.drafts.some(d => ids.includes(d.id))) return 'done'
      if (doc.drafts.filter(d => ids.includes(d.id)).some(d => d.intent?.commitId !== commitId)) return 'pending'
      publish(ctx, doc, doc.drafts.filter(d => !ids.includes(d.id))); return 'done'
    } catch { return 'pending' }
  }
  return {
    list(ctx: EditingContext) { ctx.assertCurrent(); return repository.read(ctx.scope.root).drafts.map(summary) },
    detail(ctx: EditingContext, id: string) {
      ctx.assertCurrent(); parse(editingId, id); const draft = repository.read(ctx.scope.root).drafts.find(d => d.id === id)
      if (!draft) throw new EditingError('CONFLICT', '恢复草稿已变化')
      return { draft, status: status(draft) }
    },
    open(ctx: EditingContext, owner: number, paperId: string, kind: EditingKind, resume?: { draftId: string; revision: number }) {
      ctx.assertCurrent(); parse(editingPaperId, paperId); parse(editingKindSchema, kind)
      for (const [id, s] of sessions) if (s.owner === owner && !equal(s.scope, ctx.scope)) sessions.delete(id)
      const doc = repository.read(ctx.scope.root), existing = doc.drafts.filter(d => d.paperId === paperId && d.kind === kind).map(summary)
      const paper = host.readPaper(paperId), base: EditingFields = kind === 'tags' ? { tags: clone(paper?.tags ?? []) } : { notes: paper?.notes ?? '' }
      let draft: EditingDraft | undefined
      if (resume) {
        parse(z.object({ draftId: editingId, revision: editingRevision }).strict(), resume)
        draft = doc.drafts.find(d => d.id === resume.draftId && d.paperId === paperId && d.kind === kind)
        if (!draft || draft.revision !== resume.revision || status(draft) !== 'editable') throw new EditingError('CONFLICT', '不能覆盖旧草稿或当前文献，请先对照')
      } else if (existing.length || !paper || paper.removedAt) return { base, existing, revision: 0 }
      active(ctx, paperId)
      if (sessions.size >= 1000) throw new EditingError('LIMIT_EXCEEDED', '编辑会话过多，请关闭不用的编辑器')
      const sessionId = newId()
      sessions.set(sessionId, { owner, scope: clone(ctx.scope), paperId, kind, base: clone(draft?.base ?? base), draftId: draft?.id ?? newId(), revision: draft?.revision ?? 0, sequence: 0 })
      return { base: clone(draft?.base ?? base), existing, sessionId, revision: draft?.revision ?? 0 }
    },
    save(ctx: EditingContext, owner: number, raw: SessionWrite) {
      const doc = repository.read(ctx.scope.root), { w, s } = checkWrite(ctx, owner, raw, doc)
      if (busy.has(ctx.scope.root + s.paperId)) throw new EditingError('CONFLICT', '文献正在保存')
      const revision = doc.revision + 1
      const draft: EditingDraft = { id: s.draftId, paperId: s.paperId, kind: s.kind, base: clone(s.base), input: w.input, revision, updatedAt: now().toISOString() }
      const others = clearIntents(doc.drafts, new Set([s.draftId]), revision).filter(d => d.id !== s.draftId)
      publish(ctx, doc, [...others, draft]); s.revision = revision; s.sequence = w.sequence; s.prepared = undefined
      return draft
    },
    async commit(ctx: EditingContext, owner: number, raws: SessionWrite[]): Promise<CommitReply> {
      const writes = parse(z.array(sessionWriteSchema).min(1).max(2), raws), key = JSON.stringify(writes)
      const first = session(ctx, owner, writes[0].sessionId)
      if (first.completed) {
        if (first.completed.key !== key) throw new EditingError('CONFLICT')
        const current = active(ctx, first.paperId), saved = first.completed
        if (!matches(current, saved.result)) throw new EditingError('CONFLICT', '上次保存之后文献已有更新，请重新读取；不会再次追加')
        const cleared = saved.reply.cleanup === 'done' ? 'done' : cleanup(ctx, saved.ids, saved.commitId)
        return { paper: current, state: 'already-saved', cleanup: cleared, ...(cleared === 'pending' ? { warning: saved.reply.warning } : {}) }
      }
      const doc = repository.read(ctx.scope.root), checked = writes.map(w => checkWrite(ctx, owner, w, doc)), paperId = first.paperId
      if (checked.some(c => c.s.paperId !== paperId) || new Set(checked.map(c => field(c.s.kind))).size !== checked.length) throw new EditingError('BAD_REQUEST', '只能合并同一文献的笔记和标签')
      const busyKey = ctx.scope.root + paperId
      if (busy.has(busyKey)) throw new EditingError('CONFLICT', '文献正在保存')
      busy.add(busyKey)
      try {
        const base: EditingFields = Object.assign({}, ...checked.map(c => c.s.base)), result: EditingFields = {}
        const prior = checked[0].d?.intent
        const ids = checked.map(c => c.s.draftId)
        const reuse = prior && equal(prior.draftIds, ids) && checked.every(c => c.d?.intent?.commitId === prior.commitId && c.d.input === c.w.input)
        for (const { s, w } of checked) {
          if (s.kind === 'tags') result.tags = tagsOf(w.input)
          else result.notes = s.kind === 'append' ? appendReadingNote(s.base.notes!, w.input, now()) : w.input
        }
        const intent = reuse ? prior : { commitId: newId(), draftIds: ids, base, result, preparedAt: now().toISOString() }
        if (!reuse) {
          const revision = doc.revision + 1
          const rows = checked.map(({ s, w }) => ({ id: s.draftId, paperId, kind: s.kind, base: clone(s.base), input: w.input, revision, updatedAt: now().toISOString(), intent }))
          publish(ctx, doc, [...clearIntents(doc.drafts, new Set(ids), revision).filter(d => !ids.includes(d.id)), ...rows])
          for (const { s, w } of checked) { s.revision = revision; s.sequence = w.sequence; s.prepared = clone(w) }
        }
        ctx.assertCurrent()
        if (checked.some(c => sessions.get(c.w.sessionId) !== c.s)) throw new EditingError('SESSION_CLOSED')
        const current = active(ctx, paperId)
        let paper: PaperRecord, state: CommitReply['state'] = 'saved'
        if (matches(current, intent.result)) { paper = current; state = 'already-saved' }
        else {
          if (!matches(current, intent.base)) throw new EditingError('CONFLICT', '文献内容已变化，输入保留')
          // Host adapter runs the existing synchronous read/merge/write before yielding its promise.
          paper = await host.updatePaper({ arxivId: paperId, ...intent.result })
        }
        const cleared = cleanup(ctx, ids, intent.commitId)
        const reply: CommitReply = { paper, state, cleanup: cleared, ...(cleared === 'pending' ? { warning: '文献已保存，恢复草稿清理失败；请勿重复追加，可稍后清理' } : {}) }
        for (const { s } of checked) s.completed = { key, reply: clone(reply), result: clone(intent.result), ids: [...ids], commitId: intent.commitId }
        return reply
      } finally { busy.delete(busyKey) }
    },
    discard(ctx: EditingContext, owner: number, id: string, revision: number, sessionId?: string) {
      ctx.assertCurrent(); parse(editingId, id); parse(editingRevision, revision)
      if (sessionId) { const s = session(ctx, owner, sessionId); if (s.draftId !== id) throw new EditingError('BAD_REQUEST') }
      const doc = repository.read(ctx.scope.root), d = doc.drafts.find(row => row.id === id)
      if (!d || d.revision !== revision) throw new EditingError('CONFLICT', '恢复草稿已变化')
      if (busy.has(ctx.scope.root + d.paperId)) throw new EditingError('CONFLICT', '文献正在保存')
      // Revoke before publication: even a failed discard cannot allow an already queued write to revive it.
      for (const [key, s] of sessions) if (s.scope.root === ctx.scope.root && s.draftId === id) sessions.delete(key)
      publish(ctx, doc, clearIntents(doc.drafts, new Set([id]), doc.revision + 1).filter(row => row.id !== id))
    },
    close(ctx: EditingContext, owner: number, id: string) { session(ctx, owner, id); sessions.delete(id) },
    closeOwner(owner: number) { for (const [key, s] of sessions) if (s.owner === owner) sessions.delete(key) },
    async saveWithoutRecovery(ctx: EditingContext, _owner: number, raw: Fallback): Promise<PaperRecord> {
      const request = parse(fallbackSchema, raw), p = active(ctx, request.paperId)
      const fields: EditingFields = request.appendInput !== undefined ? { notes: appendReadingNote(p.notes, request.appendInput, now()) } : request.fields!
      if (!equal(Object.keys(request.base).sort(), Object.keys(fields).sort()) || !matches(p, request.base)) throw new EditingError('CONFLICT', '正式文献已有更新，输入保留')
      const key = ctx.scope.root + request.paperId
      if (busy.has(key)) throw new EditingError('CONFLICT', '文献正在保存')
      busy.add(key)
      try { ctx.assertCurrent(); return await host.updatePaper({ arxivId: request.paperId, ...fields }) } finally { busy.delete(key) }
    }
  }
}
