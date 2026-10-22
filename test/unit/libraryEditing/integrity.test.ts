import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditingRepository } from '../../../electron/libraryEditing/repository'
import { inspectEditingIntegrity, readEditingPaperCatalog } from '../../../electron/libraryEditing/integrity'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })))
function setup() { const root = mkdtempSync(join(tmpdir(), 'editing-integrity-')); roots.push(root); return root }
it('missing draft file is old-compatible and read-only', () => { const root = setup(); expect(inspectEditingIntegrity(root)).toEqual({ state: 'unused', draftCount: 0, unresolvedCount: 0 }); expect(existsSync(join(root, '.mimir'))).toBe(false) })
it.each(['missing', 'trashed', 'active'] as const)('%s paper association is counted without deleting or exposing text', status => {
  const root = setup(), repo = createEditingRepository(), d = { id: randomUUID(), paperId: 'p', kind: 'notes' as const, base: { notes: 'private base' }, input: 'private input', revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' }
  repo.commit(root, 0, { schemaVersion: 1, revision: 1, drafts: [d] }, () => {})
  const paper = { arxivId: 'p', notes: 'private base', tags: [], ...(status === 'trashed' ? { removedAt: '2026-10-23T00:00:00.000Z' } : {}) }
  writeFileSync(join(root, '.mimir/store.json'), JSON.stringify({ 'library:papers': status === 'missing' ? {} : { p: paper } }))
  const before = readFileSync(join(root, '.mimir/library-editing/drafts.json'))
  expect(inspectEditingIntegrity(root)).toMatchObject({ state: status === 'active' ? 'valid' : 'warning', draftCount: 1, unresolvedCount: status === 'active' ? 0 : 1 })
  expect(JSON.stringify(inspectEditingIntegrity(root))).not.toContain('private'); expect(readFileSync(join(root, '.mimir/library-editing/drafts.json'))).toEqual(before)
})
it.each(['{', '{"schemaVersion":2}'])('corrupt or newer drafts remain unchanged and do not report an empty valid module', raw => {
  const root = setup(); mkdirSync(join(root, '.mimir/library-editing'), { recursive: true }); const path = join(root, '.mimir/library-editing/drafts.json'); writeFileSync(path, raw)
  expect(inspectEditingIntegrity(root).state).toBe(raw === '{' ? 'invalid' : 'unsupported'); expect(readFileSync(path, 'utf8')).toBe(raw)
})
it('linked draft catalogue requires a valid notes/tags identity instead of trusting a partial paper', () => {
  const root = setup(); mkdirSync(join(root, '.mimir')); writeFileSync(join(root, '.mimir/store.json'), JSON.stringify({ 'library:papers': { p: { arxivId: 'other', notes: 'base', tags: [] } } }))
  expect(() => readEditingPaperCatalog(root)).toThrow()
})
