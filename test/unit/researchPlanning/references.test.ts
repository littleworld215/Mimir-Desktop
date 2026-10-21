import { expect, it } from 'vitest'
import { planningReferences, validatePlanningReferences } from '../../../electron/researchPlanning/references'
import { emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

const data: Record<string, unknown> = {
  'library:papers': [{ arxivId: 'doi:10.1000/paper', title: '本地文献' }],
  'library:projects': [{ id: 'library-project', title: '文献课题' }],
  'experiments:list': Array.from({ length: 55 }, (_, i) => ({ id: `experiment${i}`, name: `合成实验${i}` }))
}
const read = <T,>(key: string) => data[key] as T | undefined
it('正常文献库的arxivId字典可按原标识投影，读取和新增关联均不重写原表', () => {
  const table = { 'doi:10.1000/paper': { arxivId: 'doi:10.1000/paper', title: '字典文献', notes: '正文不传出', pdfPath: 'private.pdf' } }
  const bytes = JSON.stringify(table), dictionaryRead = <T,>(key: string) => (key === 'library:papers' ? table : undefined) as T | undefined
  expect(planningReferences(dictionaryRead, 'paper', '', 1).items).toEqual([{ id: 'doi:10.1000/paper', name: '字典文献', exists: true }])
  const input = { ...emptyPlanningInput('literature'), title: '文献计划', literature: { authors: [], year: null, doi: '', url: '', readingState: 'unread' as const, paperId: 'doi:10.1000/paper' } }
  expect(() => validatePlanningReferences(dictionaryRead, input)).not.toThrow()
  expect(JSON.stringify(table)).toBe(bytes)
})
it('字典键与文献标识不匹配时拒绝，不把键或正文冒充可用关联', () => {
  const dictionaryRead = <T,>() => ({ wrong: { arxivId: 'different', title: '错配' } }) as T
  expect(() => planningReferences(dictionaryRead, 'paper', '', 1)).toThrow(/CORRUPT_DATA/)
})
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
