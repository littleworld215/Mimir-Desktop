import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitResearch, createResearchRepository, readResearch } from '../../../electron/library/research/repository'
import { document, fixture, question } from './fixtures'

const fixtures: ReturnType<typeof fixture>[] = []
const setup = () => { const f = fixture(); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
const next = (doc: ReturnType<typeof document>) => ({ ...doc, revision: doc.revision + 1, questions: [...doc.questions, question()] })

it('absentReadDoesNotCreateDirectories，发布后可从真实文件完整重读', () => {
  const { root } = setup()
  expect(readResearch(root)).toEqual({ schemaVersion: 1, revision: 0, questions: [], packs: [] })
  expect(existsSync(join(root, '.mimir'))).toBe(false)
  const doc = document(); expect(commitResearch(root, 0, doc)).toEqual(doc)
  expect(readResearch(root)).toEqual(doc)
})
it.each(['write', 'sync', 'close', 'rename'] as const)('failedWriteSyncCloseRenamePreservesPreviousBytes：%s', stage => {
  const { root } = setup(), doc = document(); commitResearch(root, 0, doc)
  const path = join(root, '.mimir/library/research.json'), before = readFileSync(path)
  const repo = createResearchRepository({ [stage]: () => { throw Error('disk-fault') } })
  expect(() => repo.commit(root, 1, next(doc))).toThrow(/WRITE_FAILED/)
  expect(readFileSync(path)).toEqual(before)
  expect(repo.read(root)).toEqual(doc)
  expect(readdirSync(join(root, '.mimir/library'))).toEqual(['research.json'])
})
it('appendOnlyAcrossQuestionsAndPacks：不能删除实体、改历史或更换项目', () => {
  const { root } = setup(), doc = document(); commitResearch(root, 0, doc)
  for (const field of ['questions', 'packs'] as const) {
    const removed = structuredClone(doc); removed.revision++
    removed[field] = []
    expect(() => commitResearch(root, 1, removed)).toThrow()
    const altered = structuredClone(doc); altered.revision++
    altered[field][0]!.versions[0]!.note = 'changed'
    expect(() => commitResearch(root, 1, altered)).toThrow()
  }
  expect(readResearch(root)).toEqual(doc)
})
it('过期revision、发布前空间变化和并发提交不覆盖已提交资料', () => {
  const { root } = setup(), doc = document(); commitResearch(root, 0, doc)
  expect(() => commitResearch(root, 0, next(doc))).toThrow(/CONFLICT/)
  expect(() => commitResearch(root, 1, next(doc), () => { throw Error('space-change') })).toThrow()
  const concurrent = next(doc)
  expect(() => commitResearch(root, 1, next(doc), () => { commitResearch(root, 1, concurrent) })).toThrow(/CONFLICT/)
  expect(readResearch(root)).toEqual(concurrent)
})
it.each(['{bad', JSON.stringify({ schemaVersion: 2, revision: 0, questions: [], packs: [] })])('损坏/较新文件原样保留：%s', bytes => {
  const { root } = setup(), dir = join(root, '.mimir/library'); mkdirSync(dir, { recursive: true })
  const path = join(dir, 'research.json'); writeFileSync(path, bytes)
  expect(() => readResearch(root)).toThrow()
  expect(() => commitResearch(root, 0, document())).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})
it('全部历史实际UTF8超过16MiB拒绝，归档问题计入且原盘不变', () => {
  const { root } = setup(), doc = document(); commitResearch(root, 0, doc)
  const before = readFileSync(join(root, '.mimir/library/research.json')), expanded = structuredClone(doc)
  const q = expanded.questions[0]!, first = q.versions[0]!
  q.versions.push(...Array.from({ length: 1100 }, (_, i) => ({ ...first, version: i + 2, archived: true, question: '😀'.repeat(2000), note: '😀'.repeat(2000) })))
  q.currentVersion = q.versions.length; expanded.revision = 2
  expect(Buffer.byteLength(JSON.stringify(expanded))).toBeGreaterThan(16 * 1024 * 1024)
  expect(() => commitResearch(root, 1, expanded)).toThrow(/LIMIT_EXCEEDED/)
  expect(readFileSync(join(root, '.mimir/library/research.json'))).toEqual(before)
}, 20000)
it('联接目录拒绝越界读取或创建', () => {
  const { root } = setup(), outside = setup().root
  symlinkSync(outside, join(root, '.mimir'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => readResearch(root)).toThrow(/SOURCE_UNAUTHORIZED/)
  expect(() => commitResearch(root, 0, document())).toThrow(/SOURCE_UNAUTHORIZED/)
  expect(readdirSync(outside)).toEqual([])
})
it('foreignTempNeverDeleted：临时路径被替换时拒绝发布且保留外来文件', () => {
  const { root } = setup(), doc = document(); commitResearch(root, 0, doc)
  const dir = join(root, '.mimir/library'), path = join(dir, 'research.json'), before = readFileSync(path)
  let foreign = ''
  const repo = createResearchRepository({ write: () => {
    foreign = join(dir, readdirSync(dir).find(name => name.endsWith('.partial'))!)
    renameSync(foreign, `${foreign}.held`)
    writeFileSync(foreign, 'foreign-data')
  } })
  expect(() => repo.commit(root, 1, next(doc))).toThrow(/WRITE_FAILED/)
  expect(readFileSync(path)).toEqual(before)
  expect(readFileSync(foreign, 'utf8')).toBe('foreign-data')
})
