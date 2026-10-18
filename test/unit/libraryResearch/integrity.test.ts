import { afterEach, expect, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertRestoredResearchIntegrity, inspectResearchIntegrity } from '../../../electron/library/research/integrity'
import { readResearch } from '../../../electron/library/research/repository'
import { savePack } from '../../../electron/library/research/packService'
import { materialFixture, fixture } from './fixtures'

const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()) })
function seeded() {
  const f = materialFixture(); clean.push(f.clean)
  savePack(f.ctx, { input: f.packInput, expectedRevision: f.researchRevision, expectedEvidenceRevision: 1 })
  writeFileSync(join(f.root, '.mimir/store.json'), JSON.stringify({ 'library:projects': f.projects, 'library:papers': Object.fromEntries(f.papers.map(p => [p.arxivId, p])) }))
  return f
}
function bytes(root: string): unknown {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).map(e => [e.name, e.isDirectory() ? bytes(join(root, e.name)) : readFileSync(join(root, e.name)).toString('hex')]))
}
it('unusedSpaceIsNotMissingData：无文件不建目录，健康检查和恢复检查均只读', () => {
  const f = fixture(); clean.push(f.clean)
  const before = bytes(f.root)
  expect(inspectResearchIntegrity(f.root)).toEqual({ state: 'unused', questionCount: 0, packCount: 0, unresolvedCount: 0 })
  expect(() => assertRestoredResearchIntegrity(f.root)).not.toThrow()
  expect(bytes(f.root)).toEqual(before)
})
it('完整问题和素材历史有效，检查前后所有文件逐字相同', () => {
  const f = seeded(), before = bytes(f.root)
  expect(inspectResearchIntegrity(f.root)).toMatchObject({ state: 'valid', questionCount: 2, packCount: 1, unresolvedCount: 0 })
  expect(() => assertRestoredResearchIntegrity(f.root)).not.toThrow()
  expect(bytes(f.root)).toEqual(before)
})
it('researchWithoutEvidenceReportsUnresolved：缺失证据为警告而不删除问题或阻止保全恢复', () => {
  const f = seeded(), doc = readResearch(f.root), root = fixture(); clean.push(root.clean)
  mkdirSync(join(root.root, '.mimir/library'), { recursive: true })
  writeFileSync(join(root.root, '.mimir/library/research.json'), JSON.stringify(doc))
  const before = bytes(root.root)
  expect(inspectResearchIntegrity(root.root)).toMatchObject({ state: 'warning', questionCount: 2, packCount: 1 })
  expect(inspectResearchIntegrity(root.root).unresolvedCount).toBeGreaterThan(0)
  expect(inspectResearchIntegrity(root.root).code).toBe('EVIDENCE_MISSING')
  expect(() => assertRestoredResearchIntegrity(root.root)).not.toThrow()
  expect(bytes(root.root)).toEqual(before)
})
for (const file of ['research.json', 'evidence.json']) for (const newer of [false, true]) it(`${file} ${newer ? '较新格式' : '损坏'}不能发布恢复且不泄露正文`, () => {
  const f = seeded(), path = join(f.root, '.mimir/library', file)
  writeFileSync(path, newer ? JSON.stringify({ schemaVersion: 999, privateBody: '机密正文' }) : '{机密正文')
  const before = bytes(f.root), report = inspectResearchIntegrity(f.root)
  expect(report.state).toBe(newer ? 'unsupported' : 'invalid')
  expect(JSON.stringify(report)).not.toContain('机密正文')
  expect(() => assertRestoredResearchIntegrity(f.root)).toThrowError(expect.objectContaining({ code: 'RECHECK_FAILED' }))
  expect(bytes(f.root)).toEqual(before)
})

it('文献目录中的非法记录不能让引用误报健康，报告不含正文', () => {
  const f = seeded()
  writeFileSync(join(f.root, '.mimir/store.json'), JSON.stringify({ 'library:projects': f.projects, 'library:papers': { [f.papers[0]!.arxivId]: '机密正文' } }))
  expect(inspectResearchIntegrity(f.root).state).toBe('invalid')
  expect(JSON.stringify(inspectResearchIntegrity(f.root))).not.toContain('机密正文')
})
