import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningRepository, createPlanningDraftRepository, createPlanningDeliveryRepository } from '../../../electron/researchPlanning/repository'
import { emptyPlanningDocument, emptyPlanningInput } from '../../../shared/researchPlanningDefaults'
import { inspectPlanningIntegrity } from '../../../electron/researchPlanning/integrity'
import { createRestoreSteps } from '../../../electron/workspaceBackup/restoreAdapter'
import { buildDoctorReport } from '../../../electron/workspaceBackup/doctorReport'

const roots: string[] = []
const stamp = '2026-10-21T00:00:00.000Z'
function fixture() { const root = mkdtempSync(join(tmpdir(), 'mimir-plan-integrity-')); roots.push(root); return root }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const bytes = (root: string) => readdirSync(join(root, '.mimir/planning')).sort().map(name => [name, readFileSync(join(root, '.mimir/planning', name)).toString('hex')])
it('旧空间缺整个模块合法且只读不建目录；有未命名草稿也不当作损坏正式记录', async () => {
  const root = fixture(); expect(inspectPlanningIntegrity(root).state).toBe('unused'); expect(existsSync(join(root, '.mimir'))).toBe(false)
  await createRestoreSteps().recheck({} as never, root)
  createPlanningDraftRepository().commit(root, 0, { schemaVersion: 1, revision: 1, drafts: [{ id: 'unfinished', itemId: null, baseRevision: 0, input: { ...emptyPlanningInput('schedule'), schedule: { date: '2026-10-21', start: '10:00', end: null } }, updatedAt: stamp }] })
  const before = bytes(root)
  expect(inspectPlanningIntegrity(root)).toMatchObject({ state: 'valid', itemCount: 0, draftCount: 1, deliveryCount: 0 })
  expect(bytes(root)).toEqual(before)
})
it.each(['planning.json', 'drafts.json', 'deliveries.json'])('没有assets.db也拒绝较新%s，坏文件原字节不改', async name => {
  const root = fixture(), folder = join(root, '.mimir/planning'); mkdirSync(folder, { recursive: true })
  const path = join(folder, name), value = '{"schemaVersion":99}'; writeFileSync(path, value)
  expect(inspectPlanningIntegrity(root)).toMatchObject({ state: 'unsupported', code: 'UNSUPPORTED_VERSION' })
  await expect(createRestoreSteps().recheck({} as never, root)).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(path, 'utf8')).toBe(value)
  writeFileSync(path, '{broken')
  expect(inspectPlanningIntegrity(root)).toMatchObject({ state: 'invalid', code: 'CORRUPT_DATA' })
  await expect(createRestoreSteps().recheck({} as never, root)).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
})
it('正式记录、草稿和提醒全部计数；宿主字典合法时有效，失联只警告并完整保留', async () => {
  const root = fixture(), repo = createPlanningRepository(), doc = emptyPlanningDocument()
  doc.revision = 1; doc.items = [{ ...emptyPlanningInput('literature'), id: 'lit', title: '合成文献计划', literature: { authors: [], year: null, doi: '', url: '', readingState: 'unread', paperId: 'paper' }, createdAt: stamp, updatedAt: stamp }]
  doc.items.push({ ...emptyPlanningInput('todo'), id: 'todo', title: '合成到期待办', dueDate: '2026-10-21', createdAt: stamp, updatedAt: stamp })
  repo.commit(root, 0, doc)
  const storePath = join(root, '.mimir/store.json'); writeFileSync(storePath, JSON.stringify({ 'library:papers': { paper: { arxivId: 'paper', title: '正常字典文献' } } }))
  createPlanningDraftRepository().commit(root, 0, { schemaVersion: 1, revision: 1, drafts: [{ id: 'draft', itemId: 'lit', baseRevision: 1, input: emptyPlanningInput('literature'), updatedAt: stamp }] })
  createPlanningDeliveryRepository().commit(root, 0, { schemaVersion: 1, revision: 1, deliveries: [{ itemId: 'todo', dueDate: '2026-10-21', deliveredAt: stamp }] })
  expect(inspectPlanningIntegrity(root)).toMatchObject({ state: 'valid', itemCount: 2, draftCount: 1, deliveryCount: 1 })
  writeFileSync(storePath, '{}'); const before = bytes(root)
  expect(inspectPlanningIntegrity(root)).toMatchObject({ state: 'warning', unresolvedCount: 1 })
  await createRestoreSteps().recheck({} as never, root)
  expect(bytes(root)).toEqual(before)
})
it('只读自检将计划坏库列为错误，不因没有资产库跳过，也不暴露正文或路径', async () => {
  const root = fixture(), folder = join(root, '.mimir/planning'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'drafts.json'), '{private body')
  const before = bytes(root)
  const result = await buildDoctorReport({ home: root, readRegistry: () => [{ id: 'space', name: '合成空间' }] as never, resolveSpaces: () => [{ id: 'space', name: '合成空间', path: root }], listArchives: async () => [], scanResiduals: async () => [], checkSpaceIntegrity: async () => {} })
  const check = result.checks.find(c => c.id === 'PLANNING_INTEGRITY')
  expect(check).toMatchObject({ severity: 'error', facts: { items: 0, drafts: 0, deliveries: 0 } })
  expect(check?.detail).not.toContain(root); expect(check?.detail).not.toContain('private body'); expect(bytes(root)).toEqual(before)
})
