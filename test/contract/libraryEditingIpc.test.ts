import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { registerLibraryEditingHandlers } from '../../electron/ipc/libraryEditing'
import { createEditingService } from '../../electron/libraryEditing/service'
import { createEditingRuntime } from '../../electron/libraryEditing/runtime'
import { WorkspaceOperationGate } from '../../electron/workspaceBackup/operationGate'
import type { PaperRecord } from '../../shared/libraryPaperRecord'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { handle: (n: string, f: any) => handlers.set(n, f) } }))
let root: string, scope: { workspaceId: string; spaceEpoch: string }, sender: EventEmitter & { id: number; mainFrame: object; isDestroyed(): boolean }, closed: boolean
let service: ReturnType<typeof createEditingService>, host: { readPaper: () => PaperRecord; updatePaper: ReturnType<typeof vi.fn> }
beforeEach(() => {
  handlers.clear(); closed = false; root = mkdtempSync(join(tmpdir(), 'editing-ipc-')); scope = { workspaceId: 's', spaceEpoch: '1' }
  sender = Object.assign(new EventEmitter(), { id: 7, mainFrame: {}, isDestroyed: () => closed })
  const paper = { arxivId: 'p', title: '', authors: [], summary: '', url: '', notes: 'base', tags: [], projectIds: [], addedAt: '' }
  host = { readPaper: () => paper, updatePaper: vi.fn(async r => ({ ...paper, ...r })) }; service = createEditingService({ host })
  const runtime = createEditingRuntime({ gate: new WorkspaceOperationGate(), capture: () => ({ id: 's', epoch: '1', root }) })
  registerLibraryEditingHandlers({ windowRef: { current: { webContents: sender, isDestroyed: () => closed } as unknown as BrowserWindow }, runtime, service })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const call = (n: string, r: unknown = {}) => handlers.get('libraryEditing:' + n)!({ sender, senderFrame: sender.mainFrame }, r)
it('registers exactly eight fixed methods and only the main window main frame', async () => {
  expect([...handlers.keys()].sort()).toEqual(['close','commit','detail','discard','list','open','saveDraft','saveWithoutRecovery'].map(n => 'libraryEditing:' + n).sort())
  for (const e of [{}, { sender: {} }, { sender, senderFrame: {} }]) expect(await handlers.get('libraryEditing:list')!(e, {})).toMatchObject({ ok: false })
  expect(await call('list')).toMatchObject({ ok: true, scope, drafts: [] })
})
it('malformed DTO, extra paths, extra arguments and stale ID/epoch never call the host', async () => {
  for (const r of [null, { scope, path: 'C:/arbitrary' }, { scope, paperId: 'p', kind: 'notes', path: root }, { scope: { ...scope, spaceEpoch: '0' }, paperId: 'p', kind: 'notes' }, { scope: { ...scope, workspaceId: 'other' }, paperId: 'p', kind: 'notes' }]) expect(await call('open', r)).toMatchObject({ ok: false })
  expect(await handlers.get('libraryEditing:list')!({ sender, senderFrame: sender.mainFrame }, {}, 'extra')).toMatchObject({ ok: false })
  expect(host.updatePaper).not.toHaveBeenCalled()
})
it('sender destruction invalidates old tokens even after a replacement window opens', async () => {
  const opened = await call('open', { scope, paperId: 'p', kind: 'notes' }); expect(opened.sessionId).toBeTruthy()
  sender.emit('destroyed')
  expect(await call('saveDraft', { scope, write: { sessionId: opened.sessionId, expectedRevision: 0, sequence: 1, input: 'late' } })).toMatchObject({ ok: false, code: 'SESSION_CLOSED' })
  expect(host.updatePaper).not.toHaveBeenCalled()
})
it('preload-shaped save and commit returns confirmed data, list contains no draft body', async () => {
  const opened = await call('open', { scope, paperId: 'p', kind: 'notes' }), write = { sessionId: opened.sessionId, expectedRevision: 0, sequence: 1, input: '\n new \n' }
  const saved = await call('saveDraft', { scope, write }); expect(saved.ok).toBe(true)
  const listed = await call('list'); expect(listed.drafts[0]).not.toHaveProperty('input')
  const result = await call('commit', { scope, writes: [{ ...write, sequence: 2, expectedRevision: saved.draft.revision }] })
  expect(result).toMatchObject({ ok: true, state: 'saved', paper: { notes: '\n new \n' } }); expect(host.updatePaper).toHaveBeenCalledTimes(1)
})
