import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createEditingRepository } from '../../../electron/libraryEditing/repository'
import { createEditingService } from '../../../electron/libraryEditing/service'
import type { PaperRecord } from '../../../shared/libraryPaperRecord'
import type { EditingKind, SessionWrite } from '../../../shared/libraryEditingContracts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-edit-session-')); roots.push(root)
  let paper: PaperRecord | undefined = { arxivId: 'p', title: 'synthetic', authors: [], summary: '', url: '', notes: 'base', tags: ['old'], projectIds: [], addedAt: '2026-10-23T00:00:00.000Z' }
  let failDisk = false, failFormal = false, failCleanup = false, current = true
  const repository = createEditingRepository({ rename() { if (failDisk) throw Error('synthetic disk failure') } })
  const host = { readPaper: () => paper && structuredClone(paper), updatePaper: vi.fn(async (r: { arxivId: string; notes?: string; tags?: string[] }) => { if (failFormal) throw Error('synthetic formal failure'); paper = { ...paper!, ...r }; if (failCleanup) failDisk = true; return structuredClone(paper) }) }
  const options = { repository, host, now: () => new Date('2026-10-23T00:00:00.000Z'), newId: randomUUID }
  const service = createEditingService(options), ctx = { scope: { id: 'space', epoch: '1', root }, assertCurrent() { if (!current) throw Error('SPACE_CHANGED') } }
  const open = (kind: EditingKind = 'notes') => service.open(ctx, 7, 'p', kind)
  const write = (kind: EditingKind = 'notes', input = 'new'): SessionWrite => ({ sessionId: open(kind).sessionId!, expectedRevision: 0, sequence: 1, input })
  return { root, repository, service, ctx, host, options, open, write, paper: () => paper!, change: (fields: Partial<PaperRecord>) => { paper = { ...paper!, ...fields } }, missing: () => { paper = undefined }, disk: (b = true) => { failDisk = b }, formal: (b = true) => { failFormal = b }, cleanup: () => { failCleanup = true }, switch: () => { current = false } }
}
it('combined notes/tags writes once and preserves another paper draft', async () => {
  const s = setup(), notes = s.write(), tags = s.write('tags', '  a, a, b  ')
  const reply = await s.service.commit(s.ctx, 7, [notes, tags])
  expect(reply).toMatchObject({ state: 'saved', cleanup: 'done', paper: { notes: 'new', tags: ['a', 'b'] } })
  expect(s.host.updatePaper).toHaveBeenCalledTimes(1); expect(s.service.list(s.ctx)).toEqual([])
})
it('saving one field does not clear an unrelated tags draft', async () => {
  const s = setup(), tags = s.write('tags', 'future'); const saved = s.service.save(s.ctx, 7, tags)
  await s.service.commit(s.ctx, 7, [s.write()])
  expect(s.service.detail(s.ctx, saved.id).draft.input).toBe('future')
})
it('rejects mixed append and replacement without preparing or formal writes', async () => {
  const s = setup()
  await expect(s.service.commit(s.ctx, 7, [s.write(), s.write('append')])).rejects.toThrow(/BAD_REQUEST/)
  expect(s.host.updatePaper).not.toHaveBeenCalled(); expect(s.repository.read(s.root).drafts).toEqual([])
})
it('old sequence, stale revision, foreign owner and closed sessions cannot resurrect drafts', () => {
  const s = setup(), w = s.write(), draft = s.service.save(s.ctx, 7, w)
  expect(() => s.service.save(s.ctx, 7, w)).toThrow(/CONFLICT/)
  expect(() => s.service.save(s.ctx, 8, { ...w, expectedRevision: draft.revision, sequence: 2 })).toThrow(/SESSION_CLOSED/)
  s.service.close(s.ctx, 7, w.sessionId)
  expect(() => s.service.save(s.ctx, 7, { ...w, expectedRevision: draft.revision, sequence: 2 })).toThrow(/SESSION_CLOSED/)
  expect(s.service.list(s.ctx)).toHaveLength(1)
})
it('discard invalidates the writable token before a delayed autosave', () => {
  const s = setup(), w = s.write(), d = s.service.save(s.ctx, 7, w)
  s.service.discard(s.ctx, 7, d.id, d.revision, w.sessionId)
  expect(() => s.service.save(s.ctx, 7, { ...w, expectedRevision: d.revision, sequence: 2 })).toThrow(/SESSION_CLOSED/)
  expect(s.service.list(s.ctx)).toEqual([])
})
it('prepare failure does not call formal update or fall back automatically', async () => {
  const s = setup(), w = s.write(); s.disk()
  await expect(s.service.commit(s.ctx, 7, [w])).rejects.toThrow(/WRITE_FAILED/)
  expect(s.host.updatePaper).not.toHaveBeenCalled(); expect(s.paper().notes).toBe('base')
})
it('formal failure preserves input and a retry keeps the original prepared timestamp', async () => {
  const s = setup(), w = s.write('append', '  addition \n'); s.formal()
  await expect(s.service.commit(s.ctx, 7, [w])).rejects.toThrow()
  const before = s.repository.read(s.root).drafts[0]; expect(before.input).toBe(w.input)
  s.formal(false); await s.service.commit(s.ctx, 7, [w])
  expect(s.paper().notes).toBe(before.intent!.result.notes); expect(s.host.updatePaper).toHaveBeenCalledTimes(2)
})
it('formal success with failed cleanup is success and retry does not append again', async () => {
  const s = setup(), w = s.write('append', 'addition'); s.cleanup()
  const first = await s.service.commit(s.ctx, 7, [w]); const bytes = readFileSync(join(s.root, '.mimir/library-editing/drafts.json'))
  expect(first).toMatchObject({ state: 'saved', cleanup: 'pending' })
  const second = await s.service.commit(s.ctx, 7, [w]); expect(second.state).toBe('already-saved')
  expect(s.host.updatePaper).toHaveBeenCalledTimes(1); expect(readFileSync(join(s.root, '.mimir/library-editing/drafts.json'))).toEqual(bytes)
  expect(s.paper().notes.match(/addition/g)).toHaveLength(1)
})
it('restart detects applied intent without writing and refuses an editable resume', async () => {
  const s = setup(), w = s.write('append'); s.cleanup(); await s.service.commit(s.ctx, 7, [w])
  const restarted = createEditingService(s.options), d = s.repository.read(s.root).drafts[0]
  expect(restarted.detail(s.ctx, d.id).status).toBe('already-saved')
  expect(() => restarted.open(s.ctx, 7, 'p', 'append', { draftId: d.id, revision: d.revision })).toThrow(/CONFLICT/)
  expect(s.host.updatePaper).toHaveBeenCalledTimes(1)
})
it('prepared intent against base is retryable, a third formal value is conflict', async () => {
  const s = setup(), w = s.write('append'); s.formal(); await expect(s.service.commit(s.ctx, 7, [w])).rejects.toThrow()
  const d = s.repository.read(s.root).drafts[0], restarted = createEditingService(s.options)
  expect(restarted.detail(s.ctx, d.id).status).toBe('editable'); s.change({ notes: 'third' })
  expect(restarted.detail(s.ctx, d.id).status).toBe('conflict')
})
it('existing drafts require explicit matching resume; conflicts preserve all three versions', () => {
  const s = setup(), d = s.service.save(s.ctx, 7, s.write('notes', '\n raw \n'))
  expect(s.open().sessionId).toBeUndefined()
  expect(() => s.service.open(s.ctx, 7, 'p', 'notes', { draftId: d.id, revision: d.revision + 1 })).toThrow(/CONFLICT/)
  const resumed = s.service.open(s.ctx, 7, 'p', 'notes', { draftId: d.id, revision: d.revision }); expect(resumed.sessionId).toBeTruthy()
  s.change({ notes: 'other' }); expect(() => s.service.open(s.ctx, 7, 'p', 'notes', { draftId: d.id, revision: d.revision })).toThrow(/CONFLICT/)
  expect(s.service.detail(s.ctx, d.id).draft).toMatchObject({ input: '\n raw \n', base: { notes: 'base' } }); expect(s.paper().notes).toBe('other')
})
it('fallback preserves existing drafts and combines notes/tags in one formal update', async () => {
  const s = setup(), d = s.service.save(s.ctx, 7, s.write()); s.disk()
  const p = await s.service.saveWithoutRecovery(s.ctx, 7, { paperId: 'p', base: { notes: 'base', tags: ['old'] }, fields: { notes: 'legacy', tags: ['x'] } })
  expect(p.notes).toBe('legacy'); expect(s.host.updatePaper).toHaveBeenCalledTimes(1)
  expect(s.repository.read(s.root).drafts[0]).toEqual(d)
})
it('oversized recovery input still allows explicitly chosen legacy saving', async () => {
  const s = setup(), input = 'x'.repeat(2 * 1024 * 1024), w = s.write('notes', input)
  expect(() => s.service.save(s.ctx, 7, w)).toThrow(/LIMIT_EXCEEDED/)
  expect(s.host.updatePaper).not.toHaveBeenCalled()
  await s.service.saveWithoutRecovery(s.ctx, 7, { paperId: 'p', base: { notes: 'base' }, fields: { notes: input } })
  expect(s.paper().notes).toBe(input)
})
it.each(['changed', 'trashed', 'missing', 'scope'] as const)('%s rejects commit and legacy saving', async reason => {
  const s = setup(), w = s.write()
  if (reason === 'changed') s.change({ notes: 'other' }); if (reason === 'trashed') s.change({ removedAt: '2026-10-23' }); if (reason === 'missing') s.missing(); if (reason === 'scope') s.switch()
  await expect(s.service.commit(s.ctx, 7, [w])).rejects.toThrow()
  await expect(s.service.saveWithoutRecovery(s.ctx, 7, { paperId: 'p', base: { notes: 'base' }, fields: { notes: 'other' } })).rejects.toThrow()
  expect(s.host.updatePaper).not.toHaveBeenCalled()
})
it('owner close cancels every session, roots and epochs cannot be reused', () => {
  const s = setup(), w = s.write()
  expect(() => s.service.save({ ...s.ctx, scope: { ...s.ctx.scope, epoch: '2' } }, 7, w)).toThrow(/SPACE_CHANGED/)
  s.service.closeOwner(7); expect(() => s.service.save(s.ctx, 7, w)).toThrow(/SESSION_CLOSED/)
})
it('retains the existing comma-only tag rule instead of reinterpreting Chinese commas or newlines', async () => {
  const s = setup(); await s.service.commit(s.ctx, 7, [s.write('tags', '  a，b\nc, a，b\nc  ')])
  expect(s.paper().tags).toEqual(['a，b\nc'])
})
it('completed retry returns fresh unrelated fields and refuses a changed committed field', async () => {
  const s = setup(), w = s.write(); await s.service.commit(s.ctx, 7, [w])
  s.change({ tags: ['later-tags'], projectIds: ['new-project'] })
  expect(await s.service.commit(s.ctx, 7, [w])).toMatchObject({ state: 'already-saved', paper: { tags: ['later-tags'], projectIds: ['new-project'] } })
  s.change({ notes: 'later-notes' }); await expect(s.service.commit(s.ctx, 7, [w])).rejects.toThrow(/CONFLICT/)
  expect(s.host.updatePaper).toHaveBeenCalledTimes(1)
})
it('a fresh owner open after workspace change revokes obsolete in-memory tokens', () => {
  const s = setup(), w = s.write()
  s.service.open({ ...s.ctx, scope: { ...s.ctx.scope, epoch: 'next' } }, 7, 'p', 'notes')
  expect(() => s.service.save(s.ctx, 7, w)).toThrow(/SESSION_CLOSED/)
  expect(s.repository.read(s.root).drafts).toEqual([])
})
