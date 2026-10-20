import { expect, it } from 'vitest'
import { planningReferences, validatePlanningReferences } from '../../../electron/researchPlanning/references'
import { emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

const data: Record<string, unknown> = {
  'library:papers': [{ arxivId: 'doi:10.1000/paper', title: '本地文献' }],
  'library:projects': [{ id: 'library-project', title: '文献课题' }],
  'experiments:list': Array.from({ length: 55 }, (_, i) => ({ id: `experiment${i}`, name: `合成实验${i}` }))
}
const read = <T,>(key: string) => data[key] as T | undefined
it('宿主关联只投影标识和名称，50项分页；已选失联项明确报告，不传正文或路径', () => {
  const experiments = planningReferences(read, 'experiment', '', 1)
  expect(experiments.total).toBe(55); expect(experiments.items).toHaveLength(50)
  expect(planningReferences(read, 'experiment', '', 2).items).toHaveLength(5)
  expect(planningReferences(read, 'paper', '', 1).items).toEqual([{ id: 'doi:10.1000/paper', name: '本地文献', exists: true }])
  expect(planningReferences(read, 'paper', '', 1, ['missing']).items).toEqual([{ id: 'missing', name: '原关联已失联', exists: false }])
})
it('新增关联必须存在；已有失联引用可保留或清除，不跨域删除或冒名关联', () => {
  const input = { ...emptyPlanningInput('project'), libraryProjectId: 'library-project', experimentIds: ['experiment0'] }
  expect(() => validatePlanningReferences(read, input)).not.toThrow()
  const broken = { ...input, libraryProjectId: 'missing' }
  expect(() => validatePlanningReferences(read, broken)).toThrow()
  expect(() => validatePlanningReferences(read, broken, broken)).not.toThrow()
  expect(() => validatePlanningReferences(read, { ...broken, libraryProjectId: null }, broken)).not.toThrow()
})
