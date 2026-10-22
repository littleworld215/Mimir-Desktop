import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createEditingRepository } from '../../../electron/libraryEditing/repository'
import { createEditingService } from '../../../electron/libraryEditing/service'
import { readEditingPaperCatalog } from '../../../electron/libraryEditing/integrity'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { createRestoreSteps } from '../../../electron/workspaceBackup/restoreAdapter'
import { runRestore } from '../../../electron/workspaceBackup/restoreRunner'
import { stagingPathFor } from '../../../electron/workspaceBackup/stagingRoot'
const roots: string[] = [], stamp = '2026-10-23T00:00:00.000Z'
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })))
function hashes(root: string) { const out: string[] = []; function walk(d: string) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(relative(root, p) + ':' + createHash('sha256').update(readFileSync(p)).digest('hex')) } } walk(root); return out.sort() }
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'editing-restore-')); roots.push(base)
  const source = join(base, '来源'), target = join(base, '恢复😀'), home = join(base, 'home')
  for (const r of [source, home]) mkdirSync(join(r, '.mimir'), { recursive: true })
  const paper = { arxivId: 'p', title: 'synthetic', authors: [], summary: '', url: '', notes: 'base', tags: [], projectIds: [], addedAt: stamp }
  writeFileSync(join(source, '.mimir/store.json'), JSON.stringify({ 'library:papers': { p: paper } }))
  const registry = join(home, '.mimir/store.json'); writeFileSync(registry, JSON.stringify({ settings: {}, activeWorkspaceId: 'old', defaultWorkspaceId: 'old', 'workspaces:list': [{ id: 'old', name: '源', path: source, createdAt: stamp, updatedAt: stamp }] }))
  const archive = join(base, 'backup.zip')
  async function restore() { await createBackup({ root: source, destination: archive, stagingDir: join(base, 'packing'), assetsDb: null }); return runRestore({ archivePath: archive, targetRoot: target, stagingRoot: stagingPathFor(target, 'editing'), homeDir: home, spaceName: '恢复', oldRoot: source }, createRestoreSteps({ now: () => stamp }), { newId: () => 'new-uuid', now: () => new Date(stamp) }) }
  return { base, source, target, home, registry, paper, restore }
}
it('old backup missing drafts restores successfully', async () => { const f = fixture(); expect(await f.restore()).toMatchObject({ stage: 'done', failure: null }); expect(existsSync(join(f.target, '.mimir/library-editing'))).toBe(false) })
it.each(['{', '{"schemaVersion":2}'])('invalid draft blocks actual restoration publication and registration: %s', async raw => {
  const f = fixture(); mkdirSync(join(f.source, '.mimir/library-editing')); writeFileSync(join(f.source, '.mimir/library-editing/drafts.json'), raw)
  const before = hashes(f.source), registry = readFileSync(f.registry)
  expect(await f.restore()).toMatchObject({ stage: 'failed', failure: { code: 'RECHECK_FAILED' } })
  expect(existsSync(f.target)).toBe(false); expect(hashes(f.source)).toEqual(before); expect(readFileSync(f.registry)).toEqual(registry)
})
it('restored intent/input bytes remain unchanged, new UUID can resume while old root/epoch token cannot write', async () => {
  const f = fixture(), repository = createEditingRepository(), id = randomUUID()
  const draft = { id, paperId: 'p', kind: 'append' as const, base: { notes: 'base' }, input: `\n 原路径 ${f.source} \n`, revision: 1, updatedAt: stamp, intent: { commitId: randomUUID(), draftIds: [id], base: { notes: 'base' }, result: { notes: 'prepared result' }, preparedAt: stamp } }
  repository.commit(f.source, 0, { schemaVersion: 1, revision: 1, drafts: [draft] }, () => {})
  const before = hashes(f.source); expect(await f.restore()).toMatchObject({ stage: 'done' })
  expect(readFileSync(join(f.target, '.mimir/library-editing/drafts.json'))).toEqual(readFileSync(join(f.source, '.mimir/library-editing/drafts.json'))); expect(hashes(f.source)).toEqual(before)
  const updatePaper = vi.fn(), service = createEditingService({ host: { readPaper: id => readEditingPaperCatalog(f.target)[id], updatePaper } })
  const ctx = { scope: { id: 'new-uuid', epoch: 'new-epoch', root: f.target }, assertCurrent() {} }, old = { ...ctx, scope: { id: 'old', epoch: 'old-epoch', root: f.source } }
  const token = service.open(old, 7, 'p', 'append', { draftId: id, revision: 1 }).sessionId!
  expect(() => service.save(ctx, 7, { sessionId: token, expectedRevision: 1, sequence: 1, input: 'late' })).toThrow(/SPACE_CHANGED/)
  expect(service.open(ctx, 7, 'p', 'append', { draftId: id, revision: 1 }).sessionId).toBeTruthy()
  expect(service.detail(ctx, id).draft).toEqual(draft); expect(updatePaper).not.toHaveBeenCalled()
})
