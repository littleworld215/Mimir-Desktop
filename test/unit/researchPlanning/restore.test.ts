import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { runRestore } from '../../../electron/workspaceBackup/restoreRunner'
import { createRestoreSteps } from '../../../electron/workspaceBackup/restoreAdapter'
import { stagingPathFor } from '../../../electron/workspaceBackup/stagingRoot'
import { createPlanningDeliveryRepository, createPlanningDraftRepository, createPlanningRepository } from '../../../electron/researchPlanning/repository'
import { inspectPlanningIntegrity } from '../../../electron/researchPlanning/integrity'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

const roots: string[] = [], stamp = '2026-10-21T00:00:00.000Z'
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fingerprint(root: string): string[] {
  const values: string[] = []
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) walk(file); else values.push(`${relative(root, file)}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`) } }
  walk(root); return values.sort()
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mimir-planning-restore-')); roots.push(base)
  const home = join(base, 'home'), source = join(base, '源课题😀'), target = join(base, '恢复空间')
  mkdirSync(join(home, '.mimir'), { recursive: true }); mkdirSync(join(source, '.mimir'), { recursive: true })
  const registry = join(home, '.mimir/store.json'), original = { settings: { theme: 'dark', researchPlanningBackground: { tray: false, startup: false, reminders: false } }, activeWorkspaceId: 'source', defaultWorkspaceId: 'source', 'workspaces:list': [{ id: 'source', name: '原课题', path: source, createdAt: stamp, updatedAt: stamp }] }
  writeFileSync(registry, JSON.stringify(original))
  writeFileSync(join(source, '.mimir/store.json'), JSON.stringify({ 'library:papers': { paper: { arxivId: 'paper', title: '字典文献' } }, 'library:projects': [{ id: 'library', title: '文献项目' }], 'experiments:list': [{ id: 'experiment', name: '实验' }], unknownBusiness: { preserve: true } }))
  writeFileSync(join(source, '.hidden-research'), '未知隐藏资料')
  return { base, home, source, target, registry, original }
}
async function roundtrip(f: ReturnType<typeof fixture>) {
  const archive = join(f.base, 'planning-backup.zip')
  const saved = await createBackup({ root: f.source, destination: archive, stagingDir: join(f.base, 'archive-staging'), assetsDb: null })
  expect(saved.excluded).toEqual([])
  const result = await runRestore({ archivePath: archive, targetRoot: f.target, stagingRoot: stagingPathFor(f.target, 'planning'), homeDir: f.home, spaceName: '恢复的科研计划', oldRoot: f.source }, createRestoreSteps({ now: () => stamp }), { newId: () => 'restored', now: () => new Date(stamp) })
  return result
}
it('真实ZIP备份/新空间恢复保留六类记录、分组、回收站、未提交草稿和提醒；源空间所有文件哈希不变', async () => {
  const f = fixture(), doc = emptyPlanningDocument(); doc.revision = 1
  doc.collections.push({ id: 'group', name: '合成分组', order: 1, deleted: false })
  const make = (kind: Parameters<typeof emptyPlanningInput>[0], id: string) => ({ ...emptyPlanningInput(kind), id, title: `${kind}合成记录`, collectionId: 'group', content: `原路径只作正文：${f.source}\n\n  保留空白\n`, createdAt: stamp, updatedAt: stamp })
  doc.items = [make('direction', 'direction'), { ...make('project', 'project'), directionId: 'direction', libraryProjectId: 'library', experimentIds: ['experiment'] }, { ...make('todo', 'todo'), projectId: 'project', dueDate: '2026-10-21' }, { ...make('schedule', 'schedule'), schedule: { date: '2026-10-21', start: null, end: null } }, make('generic', 'record'), { ...make('literature', 'literature'), literature: { authors: ['合成作者'], year: 2026, doi: '', url: '', readingState: 'unread', paperId: 'paper' } }, { ...make('generic', 'archived'), archived: true }, { ...make('generic', 'trashed'), deleted: true }]
  createPlanningRepository().commit(f.source, 0, doc)
  createPlanningDraftRepository().commit(f.source, 0, { schemaVersion: 1, revision: 1, drafts: [{ id: 'unfinished', itemId: null, baseRevision: 1, input: { ...emptyPlanningInput('generic'), content: '\n 尚未命名\n' }, updatedAt: stamp }] })
  createPlanningDeliveryRepository().commit(f.source, 0, { schemaVersion: 1, revision: 1, deliveries: [{ itemId: 'todo', dueDate: '2026-10-21', deliveredAt: stamp }] })
  const before = fingerprint(f.source), planningBytes = ['planning.json', 'drafts.json', 'deliveries.json'].map(name => readFileSync(join(f.source, '.mimir/planning', name)))
  const result = await roundtrip(f)
  expect(result).toMatchObject({ stage: 'done', failure: null })
  expect(inspectPlanningIntegrity(f.target)).toMatchObject({ state: 'valid', itemCount: 8, draftCount: 1, deliveryCount: 1, unresolvedCount: 0 })
  for (const [i, name] of ['planning.json', 'drafts.json', 'deliveries.json'].entries()) expect(readFileSync(join(f.target, '.mimir/planning', name))).toEqual(planningBytes[i])
  expect(readFileSync(join(f.target, '.hidden-research'), 'utf8')).toBe('未知隐藏资料')
  expect(fingerprint(f.source)).toEqual(before)
  const after = JSON.parse(readFileSync(f.registry, 'utf8')); expect(after['workspaces:list']).toHaveLength(2); expect(after.activeWorkspaceId).toBe('source'); expect(after.defaultWorkspaceId).toBe('source'); expect(after.settings).toEqual(f.original.settings)
})
it.each(['planning.json', 'drafts.json', 'deliveries.json'])('真实归档包含较新%s时禁止发布和注册，源数据/原注册表哈希不变', async name => {
  const f = fixture(), dir = join(f.source, '.mimir/planning'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), '{"schemaVersion":99}')
  const sourceBefore = fingerprint(f.source), registryBefore = readFileSync(f.registry)
  const result = await roundtrip(f)
  expect(result).toMatchObject({ stage: 'failed', failure: { code: 'RECHECK_FAILED' } })
  expect(existsSync(f.target)).toBe(false); expect(fingerprint(f.source)).toEqual(sourceBefore); expect(readFileSync(f.registry)).toEqual(registryBefore)
})
