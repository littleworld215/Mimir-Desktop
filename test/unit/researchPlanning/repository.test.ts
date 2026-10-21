import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, renameSync, truncateSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanningRepository } from '../../../electron/researchPlanning/repository'
import { emptyPlanningDocument, parsePlanningDocument } from '../../../electron/researchPlanning/validation'
import { emptyPlanningInput } from '../../../shared/researchPlanningDefaults'

const roots: string[] = []
function fixture() { const root = mkdtempSync(join(tmpdir(), 'mimir-planning-')); roots.push(root); return root }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const next = () => ({ ...emptyPlanningDocument(), revision: 1 })

it('空读不建目录；Unicode分组原子保存并完整重读', () => {
  const root = fixture(), repo = createPlanningRepository(), initial = repo.read(root)
  expect(initial.items).toEqual([])
  expect(existsSync(join(root, '.mimir'))).toBe(false)
  const document = next(); document.collections[0]!.name = '课题😀'
  repo.commit(root, 0, document)
  expect(repo.read(root)).toEqual(document)
})
it.each(['write', 'sync', 'close', 'rename'] as const)('真实IO的%s失败保留原字节且清理本次临时文件', stage => {
  const root = fixture(), doc = next(), repo = createPlanningRepository(); repo.commit(root, 0, doc)
  const file = join(root, '.mimir/planning/planning.json'), original = readFileSync(file)
  const failing = createPlanningRepository({ [stage]: () => { throw Error('disk-fault') } })
  expect(() => failing.commit(root, 1, { ...doc, revision: 2 })).toThrow(/WRITE_FAILED/)
  expect(readFileSync(file)).toEqual(original)
  expect(readdirSync(join(root, '.mimir/planning'))).toEqual(['planning.json'])
})
it('修订冲突和发布前空间变化均不能覆盖旧资料', () => {
  const root = fixture(), doc = next(), repo = createPlanningRepository(); repo.commit(root, 0, doc)
  expect(() => repo.commit(root, 0, { ...doc, revision: 2 })).toThrow(/CONFLICT/)
  expect(() => repo.commit(root, 1, { ...doc, revision: 2 }, () => { throw Error('SPACE_CHANGED') })).toThrow()
  expect(repo.read(root)).toEqual(doc)
})
it.each(['{bad', '{"schemaVersion":2}'])('损坏或较新文件不可重置：%s', raw => {
  const root = fixture(), folder = join(root, '.mimir/planning'); mkdirSync(folder, { recursive: true })
  const file = join(folder, 'planning.json'); writeFileSync(file, raw)
  const repo = createPlanningRepository()
  expect(() => repo.read(root)).toThrow()
  expect(() => repo.commit(root, 0, next())).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(raw)
})
it('路径联接不读取或写入外部资料', () => {
  const root = fixture(), outside = fixture()
  symlinkSync(outside, join(root, '.mimir'), process.platform === 'win32' ? 'junction' : 'dir')
  const repo = createPlanningRepository()
  expect(() => repo.read(root)).toThrow(/SOURCE_UNAUTHORIZED/)
  expect(() => repo.commit(root, 0, next())).toThrow(/SOURCE_UNAUTHORIZED/)
  expect(readdirSync(outside)).toEqual([])
})
it('16MiB以上文件明确拒绝，不截断或覆盖', () => {
  const root = fixture(), repo = createPlanningRepository(); repo.commit(root, 0, next())
  const path = join(root, '.mimir/planning/planning.json'); truncateSync(path, 16 * 1024 * 1024 + 1)
  expect(() => repo.read(root)).toThrow(/LIMIT_EXCEEDED/)
  expect(() => repo.commit(root, 1, { ...next(), revision: 2 })).toThrow(/LIMIT_EXCEEDED/)
  expect(statSync(path).size).toBe(16 * 1024 * 1024 + 1)
})
it('无效UTF8不能静默变为替代字符并在后续保存中覆盖原字节', () => {
  const root = fixture(), repo = createPlanningRepository(), doc = next(); doc.collections[0]!.name = 'X'; repo.commit(root, 0, doc)
  const path = join(root, '.mimir/planning/planning.json'), bytes = readFileSync(path), marker = Buffer.from('"name":"X"'), position = bytes.indexOf(marker)
  expect(position).toBeGreaterThanOrEqual(0)
  bytes[position + Buffer.byteLength('"name":"')] = 0xff; writeFileSync(path, bytes)
  expect(() => repo.read(root)).toThrow(/CORRUPT_DATA/)
  expect(readFileSync(path)).toEqual(bytes)
})
it('被替换的外来临时文件不得发布或清理', () => {
  const root = fixture(), repo = createPlanningRepository(); repo.commit(root, 0, next())
  const folder = join(root, '.mimir/planning'), original = readFileSync(join(folder, 'planning.json'))
  let foreign = ''
  const failing = createPlanningRepository({ write: () => { foreign = join(folder, readdirSync(folder).find(n => n.endsWith('.partial'))!); renameSync(foreign, `${foreign}.held`); writeFileSync(foreign, 'foreign') } })
  expect(() => failing.commit(root, 1, { ...next(), revision: 2 })).toThrow(/WRITE_FAILED/)
  expect(readFileSync(join(folder, 'planning.json'))).toEqual(original)
  expect(readFileSync(foreign, 'utf8')).toBe('foreign')
})
it('严格拒绝重复ID、非法关联、未知字段和较新版本', () => {
  const doc = next()
  expect(() => parsePlanningDocument({ ...doc, schemaVersion: 2 })).toThrow(/UNSUPPORTED_VERSION/)
  expect(() => parsePlanningDocument({ ...doc, collections: [...doc.collections, doc.collections[0]] })).toThrow()
  expect(() => parsePlanningDocument({ ...doc, hidden: true })).toThrow()
})
it('周期来源不能形成较长环；一万条有效历史链使用迭代检查而非递归', () => {
  const doc = next(), date = '2026-10-21T00:00:00.000Z'
  const item = { ...emptyPlanningInput('todo'), title: '周期历史', createdAt: date, updatedAt: date }
  doc.items = [{ ...item, id: 'a', recurrenceParentId: 'b' }, { ...item, id: 'b', recurrenceParentId: 'a' }]
  expect(() => parsePlanningDocument(doc)).toThrow(/CORRUPT_DATA/)
  doc.items = Array.from({ length: 10_000 }, (_, i) => ({ ...item, id: `item${i}`, ...(i ? { recurrenceParentId: `item${i - 1}` } : {}) })).reverse()
  expect(parsePlanningDocument(doc).items).toHaveLength(10_000)
})
