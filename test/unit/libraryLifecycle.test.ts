import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPaperLifecycleController } from '../../electron/library/paperLifecycle'
import * as store from '../../electron/library/store'
import { deleteProject, listPapers, listTrashedPapers } from '../../electron/library/libraryService'
import { materialFixture } from './libraryResearch/fixtures'
import { savePack } from '../../electron/library/research/packService'
import { evidencePath } from '../../electron/library/evidence/repository'
import { researchPath } from '../../electron/library/research/repository'
import { planningReferences } from '../../electron/researchPlanning/references'
import { inspectResearchIntegrity } from '../../electron/library/research/integrity'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cleaners: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); while (cleaners.length) cleaners.pop()!() })
function setup() {
  const f = materialFixture()
  cleaners.push(f.clean)
  const pack = savePack(f.ctx, { input: f.packInput, expectedRevision: f.researchRevision, expectedEvidenceRevision: 1 })
  const workspace = store.createTestWorkspace('lifecycle', f.root)
  store.switchWorkspaceTo(workspace.id)
  store.setStoreValue('library:papers', Object.fromEntries(f.papers.map(p => [p.arxivId, p])))
  store.setStoreValue('library:projects', f.projects)
  const controller = createPaperLifecycleController(), scope = controller.overview().scope, id = f.papers[0]!.arxivId
  return { ...f, pack, controller, scope, id }
}
it('影响预览计入历史证据/问题/素材，移除和恢复不改一字历史或用户字段', async () => {
  const f = setup(), before = listPapers()[0]
  const history = [evidencePath(f.root), researchPath(f.root)].map(path => readFileSync(path, 'utf8'))
  const preview = f.controller.preview(f.scope, f.id, 'trash')
  expect(preview.counts).toMatchObject({ evidenceCards: 1, evidenceVersions: 1, questions: 2, packs: 1 })
  await f.controller.apply(f.scope, preview.token)
  expect(listPapers()).toEqual([])
  expect(listTrashedPapers()[0]).toMatchObject(before!)
  expect(f.controller.overview().papers).toHaveLength(1)
  await f.controller.apply(f.scope, f.controller.preview(f.scope, f.id, 'restore').token)
  expect(listPapers()).toEqual([before])
  expect([evidencePath(f.root), researchPath(f.root)].map(path => readFileSync(path, 'utf8'))).toEqual(history)
})
it('预览后笔记或关联变化阻止执行，旧token不产生部分写入', async () => {
  const f = setup(), preview = f.controller.preview(f.scope, f.id, 'trash')
  const papers = store.getStoreValue<Record<string, any>>('library:papers')!
  store.setStoreValue('library:papers', { ...papers, [f.id]: { ...papers[f.id], notes: '晚到编辑' } })
  await expect(f.controller.apply(f.scope, preview.token)).rejects.toThrow(/重新预览/)
  expect(listPapers()[0]?.notes).toBe('晚到编辑')
})
it('空间切换后同名条目不能使用旧预览', async () => {
  const f = setup(), preview = f.controller.preview(f.scope, f.id, 'trash')
  const workspace = store.createTestWorkspace('other')
  store.switchWorkspaceTo(workspace.id)
  store.setStoreValue('library:papers', { [f.id]: f.papers[0] })
  await expect(f.controller.apply(f.scope, preview.token)).rejects.toThrow(/空间已变化/)
  expect(listPapers()).toEqual(f.papers)
})
it('移除期间项目删除不擦除回收记录关联，恢复明确列出失联项目', async () => {
  const f = setup()
  await f.controller.apply(f.scope, f.controller.preview(f.scope, f.id, 'trash').token)
  deleteProject('project-1')
  const preview = f.controller.preview(f.scope, f.id, 'restore')
  expect(preview.missingProjectIds).toEqual(['project-1'])
  await f.controller.apply(f.scope, preview.token)
  expect(listPapers()[0]?.projectIds).toEqual(['project-1'])
})
it('保存失败保留预览供重试，成功token单次消费，伪造token拒绝', async () => {
  const f = setup(), preview = f.controller.preview(f.scope, f.id, 'trash')
  vi.spyOn(store, 'setStoreValue').mockImplementationOnce(() => { throw Error('合成写入失败') })
  await expect(f.controller.apply(f.scope, preview.token)).rejects.toThrow('合成写入失败')
  expect(listPapers()).toEqual(f.papers)
  await f.controller.apply(f.scope, preview.token)
  await expect(f.controller.apply(f.scope, preview.token)).rejects.toThrow(/预览已失效/)
  await expect(f.controller.apply(f.scope, 'fake')).rejects.toThrow(/预览已失效/)
})
it('过期预览不能执行', async () => {
  const f = setup(), preview = f.controller.preview(f.scope, f.id, 'trash')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000)
  await expect(f.controller.apply(f.scope, preview.token)).rejects.toThrow(/预览已失效/)
  expect(listPapers()).toEqual(f.papers)
})
it('回收后计划选择和研究自检均视为来源暂不可用，而非健康活动文献', async () => {
  const f = setup()
  await f.controller.apply(f.scope, f.controller.preview(f.scope, f.id, 'trash').token)
  expect(planningReferences(store.getStoreValue, 'paper', '', 1).items).toEqual([])
  expect(planningReferences(store.getStoreValue, 'paper', '', 1, [f.id]).items[0]?.exists).toBe(false)
  writeFileSync(join(f.root, '.mimir/store.json'), JSON.stringify({ 'library:papers': store.getStoreValue('library:papers'), 'library:projects': f.projects }))
  expect(inspectResearchIntegrity(f.root).state).toBe('warning')
})
