import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createEvidenceRepository, readEvidence, commitEvidence } from '../../../electron/library/evidence/repository'
import { document, fixture } from './fixtures'
const fixtures: ReturnType<typeof fixture>[] = []
const setup = () => { const f = fixture(); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))

it('无文件读取不创建目录，成功发布后重新读取完整一致', () => {
  const { root } = setup()
  expect(readEvidence(root)).toEqual({ schemaVersion: 1, revision: 0, cards: [] })
  expect(existsSync(join(root, '.mimir/library'))).toBe(false)
  const next = document()
  expect(commitEvidence(root, 0, next)).toEqual(next)
  expect(readEvidence(root)).toEqual(next)
})
it.each(['write', 'sync', 'close', 'rename'] as const)('%s失败不改原文件，重读不暴露未保存内容', operation => {
  const { root } = setup()
  const old = document(); commitEvidence(root, 0, old)
  const path = join(root, '.mimir/library/evidence.json'), before = readFileSync(path)
  const next = { ...old, revision: 2, cards: [...old.cards, document().cards[0]!] }
  let failed = false
  const repo = createEvidenceRepository({ [operation]: () => { if (!failed) { failed = true; throw Error('disk-fault') } } })
  expect(() => repo.commit(root, 1, next)).toThrow(/WRITE_FAILED/)
  expect(readFileSync(path)).toEqual(before)
  expect(readEvidence(root)).toEqual(old)
  expect(readdirSync(join(root, '.mimir/library'))).toEqual(['evidence.json'])
})
it('旧revision及修改已有历史均被拒绝，不覆盖当前版本', () => {
  const { root } = setup(); const old = document(); commitEvidence(root, 0, old)
  expect(() => commitEvidence(root, 0, { ...old, revision: 2 })).toThrow(/CONFLICT/)
  const altered = structuredClone(old); altered.revision = 2; altered.cards[0]!.versions[0]!.quote = '篡改历史'
  expect(() => commitEvidence(root, 1, altered)).toThrow()
  expect(readEvidence(root)).toEqual(old)
})
it.each(['{broken', JSON.stringify({ schemaVersion: 2, revision: 0, cards: [] })])('损坏/较新JSON绝不当空文件覆盖', bytes => {
  const { root } = setup(); const dir = join(root, '.mimir/library'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'evidence.json'), bytes)
  expect(() => readEvidence(root)).toThrow()
  expect(() => commitEvidence(root, 0, document())).toThrow()
  expect(readFileSync(join(dir, 'evidence.json'), 'utf8')).toBe(bytes)
})
it('全部历史的UTF-8容量超限仍拒绝，含归档卡且原盘字节不变', () => {
  const { root } = setup(), old = document(); commitEvidence(root, 0, old)
  const before = readFileSync(join(root, '.mimir/library/evidence.json'))
  const last = old.cards[0]!.versions[0]!
  const versions = [last, ...Array.from({ length: 220 }, (_, i) => ({ ...last, version: i + 2, archived: true, quote: '😀'.repeat(20000), comment: '😀'.repeat(20000) }))]
  const next = { ...old, revision: 2, cards: [{ ...old.cards[0]!, currentVersion: versions.length, versions }] }
  expect(Buffer.byteLength(JSON.stringify(next))).toBeGreaterThan(32 * 1024 * 1024)
  expect(() => commitEvidence(root, 1, next)).toThrow(/LIMIT_EXCEEDED/)
  expect(readFileSync(join(root, '.mimir/library/evidence.json'))).toEqual(before)
}, 15000)
it('目录联接不读取或覆盖空间外资料', () => {
  const { root } = setup(), outside = setup().root
  symlinkSync(outside, join(root, '.mimir'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => readEvidence(root)).toThrow(/SOURCE_UNAUTHORIZED/)
  expect(() => commitEvidence(root, 0, document())).toThrow(/SOURCE_UNAUTHORIZED/)
  expect(readdirSync(outside)).toEqual([])
})
