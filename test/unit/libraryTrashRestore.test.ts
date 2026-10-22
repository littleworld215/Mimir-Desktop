import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createBackup } from '../../electron/workspaceBackup/packer'
import { runRestore } from '../../electron/workspaceBackup/restoreRunner'
import { createRestoreSteps } from '../../electron/workspaceBackup/restoreAdapter'
import { stagingPathFor } from '../../electron/workspaceBackup/stagingRoot'
import { materialFixture } from './libraryResearch/fixtures'
import { savePack } from '../../electron/library/research/packService'
import { inspectLibraryIntegrity } from '../../electron/library/integrity'
import { emptyPlanningDocument, emptyPlanningInput } from '../../shared/researchPlanningDefaults'
import { createPlanningRepository, createPlanningDraftRepository } from '../../electron/researchPlanning/repository'
import { evidencePath } from '../../electron/library/evidence/repository'
import { researchPath } from '../../electron/library/research/repository'
import { randomUUID } from 'node:crypto'
import { createEditingRepository } from '../../electron/libraryEditing/repository'
import { inspectEditingIntegrity } from '../../electron/libraryEditing/integrity'

const clean: (() => void)[] = [], stamp = '2026-10-22T00:00:00.000Z'
afterEach(() => { while (clean.length) clean.pop()!() })
function hashes(root: string) {
  const rows: string[] = []
  function walk(dir: string) { for (const row of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, row.name); if (row.isDirectory()) walk(path); else rows.push(relative(root, path) + ':' + createHash('sha256').update(readFileSync(path)).digest('hex')) } }
  walk(root); return rows.sort()
}
function fixture() {
  const f = materialFixture(); clean.push(f.clean)
  savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  const base = mkdtempSync(join(tmpdir(), 'mimir-trash-restore-')); clean.push(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'home'), target = join(base, '恢复😀空间')
  mkdirSync(join(home, '.mimir'), { recursive: true }); mkdirSync(join(f.root, 'papers'), { recursive: true })
  const paper = { ...f.papers[0]!, notes: '原文\n\n保留段落', tags: ['keep'], removedAt: stamp, pdfPath: join(f.root, 'papers', '合成.pdf'),
    dates: { sourcePublished: { value: '2024', precision: 'year', source: 'openalex' } } }
  writeFileSync(paper.pdfPath, '%PDF-1.7\nSynthetic only')
  writeFileSync(join(f.root, '.mimir/store.json'), JSON.stringify({ 'library:papers': { [paper.arxivId]: paper }, 'library:projects': f.projects }))
  const registry = join(home, '.mimir/store.json')
  writeFileSync(registry, JSON.stringify({ settings: {}, activeWorkspaceId: 'source', defaultWorkspaceId: 'source', 'workspaces:list': [{ id: 'source', name: '源', path: f.root, createdAt: stamp, updatedAt: stamp }] }))
  const doc = emptyPlanningDocument()
  const input = { ...emptyPlanningInput('literature'), title: '计划引用', literature: { authors: [], year: 2024, doi: '', url: '', readingState: 'unread' as const, paperId: paper.arxivId } }
  doc.revision = 1; doc.items.push({ ...input, id: 'planned-paper', createdAt: stamp, updatedAt: stamp })
  createPlanningRepository().commit(f.root, 0, doc)
  createPlanningDraftRepository().commit(f.root, 0, { schemaVersion: 1, revision: 1, drafts: [{ id: 'draft', itemId: null, baseRevision: 1, input, updatedAt: stamp }] })
  createEditingRepository().commit(f.root, 0, { schemaVersion: 1, revision: 1, drafts: [{ id: randomUUID(), paperId: paper.arxivId, kind: 'notes', base: { notes: paper.notes }, input: '草稿完整保留', revision: 1, updatedAt: stamp }] }, () => {})
  return { ...f, base, home, target, registry, paper }
}
async function roundtrip(f: ReturnType<typeof fixture>) {
  const archive = join(f.base, 'backup.zip')
  await createBackup({ root: f.root, destination: archive, stagingDir: join(f.base, 'packing'), assetsDb: null })
  return runRestore({ archivePath: archive, targetRoot: f.target, stagingRoot: stagingPathFor(f.target, 'trash'), homeDir: f.home, spaceName: '恢复', oldRoot: f.root },
    createRestoreSteps({ now: () => stamp }), { newId: () => 'restored', now: () => new Date(stamp) })
}
it('真实ZIP恢复保留回收状态、日期精度、PDF和全部证据素材/计划草稿；源空间不变', async () => {
  const f = fixture(), before = hashes(f.root), history = [evidencePath(f.root), researchPath(f.root)].map(path => readFileSync(path))
  expect(await roundtrip(f)).toMatchObject({ stage: 'done', failure: null })
  const restored = JSON.parse(readFileSync(join(f.target, '.mimir/store.json'), 'utf8'))['library:papers'][f.paper.arxivId]
  expect(restored).toEqual({ ...f.paper, pdfPath: join(f.target, 'papers', '合成.pdf') })
  expect(readFileSync(restored.pdfPath)).toEqual(readFileSync(f.paper.pdfPath))
  expect([evidencePath(f.target), researchPath(f.target)].map(path => readFileSync(path))).toEqual(history)
  expect(createPlanningRepository().read(f.target).items[0]?.literature?.paperId).toBe(f.paper.arxivId)
  expect(createPlanningDraftRepository().read(f.target).drafts).toHaveLength(1)
  expect(inspectLibraryIntegrity(f.target)).toEqual({ state: 'valid', active: 0, trashed: 1 })
  expect(inspectEditingIntegrity(f.target)).toMatchObject({ state: 'warning', draftCount: 1, unresolvedCount: 1 })
  expect(readFileSync(join(f.target, '.mimir/library-editing/drafts.json'))).toEqual(readFileSync(join(f.root, '.mimir/library-editing/drafts.json')))
  expect(hashes(f.root)).toEqual(before)
})
it.each([{ removedAt: null }, { dates: { sourcePublished: { value: '2024', precision: 'day', source: 'openalex' } } }])('损坏回收/日期元数据不发布恢复目录或追加注册', async patch => {
  const f = fixture()
  writeFileSync(join(f.root, '.mimir/store.json'), JSON.stringify({ 'library:papers': { [f.paper.arxivId]: { ...f.paper, ...patch } } }))
  const before = hashes(f.root), registry = readFileSync(f.registry)
  expect(await roundtrip(f)).toMatchObject({ stage: 'failed', failure: { code: 'RECHECK_FAILED' } })
  expect(existsSync(f.target)).toBe(false); expect(hashes(f.root)).toEqual(before); expect(readFileSync(f.registry)).toEqual(registry)
})
