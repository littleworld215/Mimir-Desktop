import { expect, it } from 'vitest'
import { parseEvidenceDocument, parseEvidenceFields, assertEvidenceBytes } from '../../../electron/library/evidence/validation'
import { document, fields } from './fixtures'

it('保留摘录空白与码点边界，不允许注入可信元数据', () => {
  expect(parseEvidenceFields(fields()).quote).toBe('  摘录😀\n\n')
  expect(parseEvidenceFields({ ...fields(), question: '😀'.repeat(2000) }).question).toHaveLength(4000)
  expect(() => parseEvidenceFields({ ...fields(), question: '😀'.repeat(2001) })).toThrow()
  for (const key of ['documentBinding', 'paperSnapshot', 'reviewState', 'archived', 'updatedAt']) {
    expect(() => parseEvidenceFields({ ...fields(), [key]: true })).toThrow()
  }
})
it.each([null, [], {}, { ...fields(), quote: '', claim: '' }, { ...fields(), locator: { pageStart: 0 } }, { ...fields(), locator: { pageStart: 2, pageEnd: 1 } }, { ...fields(), locator: { pageStart: '2' } }, { ...fields(), projectIds: ['project-1', 'project-1'] }])('非法人工字段拒绝%j', input => {
  expect(() => parseEvidenceFields(input)).toThrow()
})
it('全部历史与标识均严格校验，较新格式明确拒绝', () => {
  const data = document()
  expect(parseEvidenceDocument(data)).toEqual(data)
  expect(() => parseEvidenceDocument({ ...data, schemaVersion: 2 })).toThrow(/FORMAT_UNSUPPORTED/)
  expect(() => parseEvidenceDocument({ ...data, cards: [data.cards[0], data.cards[0]] })).toThrow()
  data.cards[0]!.versions[0]!.version = 2
  expect(() => parseEvidenceDocument(data)).toThrow()
})
it.each([-1, 1.5, '1', null, true])('非法revision拒绝%j', revision => {
  expect(() => parseEvidenceDocument({ ...document(), revision })).toThrow()
})
it('5000卡与32MiB是含历史的真实边界，不静默删改', () => {
  const cards = Array.from({ length: 5000 }, () => document().cards[0]!)
  expect(parseEvidenceDocument({ schemaVersion: 1, revision: 1, cards }).cards).toHaveLength(5000)
  expect(() => parseEvidenceDocument({ schemaVersion: 1, revision: 1, cards: [...cards, document().cards[0]] })).toThrow(/LIMIT_EXCEEDED/)
  expect(() => assertEvidenceBytes(Buffer.alloc(32 * 1024 * 1024))).not.toThrow()
  expect(() => assertEvidenceBytes(Buffer.alloc(32 * 1024 * 1024 + 1))).toThrow(/LIMIT_EXCEEDED/)
})
