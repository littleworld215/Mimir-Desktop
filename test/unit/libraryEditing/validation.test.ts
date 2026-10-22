import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { parseEditingDocument, EDITING_ENTRY_BYTES, EDITING_MAX_BYTES } from '../../../electron/libraryEditing/validation'

export const draft = (input = '原文\n\n  空白  ') => ({ id: randomUUID(), paperId: 'doi:synthetic/one', kind: 'notes' as const, base: { notes: 'old' }, input, revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' })
const doc = (drafts: ReturnType<typeof draft>[]) => ({ schemaVersion: 1, revision: 1, drafts })

it('preserves empty strings, whitespace and raw tag text without normalization', () => {
  const note = draft(''), tags = { ...draft(' 中文,  , repeated , repeated '), kind: 'tags', base: { tags: ['old'] } }
  expect(parseEditingDocument({ ...doc([note]), drafts: [note, tags] }).drafts).toEqual([note, tags])
  expect(parseEditingDocument(doc([draft()])).drafts[0].input).toBe('原文\n\n  空白  ')
})
it('rejects duplicate identities, malformed revisions, kinds, fields and dates', () => {
  const row = draft()
  for (const value of [doc([row, row]), { ...doc([]), revision: -1 }, doc([{ ...row, revision: 0 }]), doc([{ ...row, updatedAt: 'tomorrow' }]), doc([{ ...row, kind: 'append', base: { tags: [] } }]), { ...doc([]), arbitraryPath: 'C:/' }]) expect(() => parseEditingDocument(value)).toThrow()
})
it('accepts exactly 1000 entries but refuses 1001 without dropping entries', () => {
  const rows = Array.from({ length: 1001 }, () => draft(''))
  expect(parseEditingDocument(doc(rows.slice(0, 1000))).drafts).toHaveLength(1000)
  expect(() => parseEditingDocument(doc(rows))).toThrow(/LIMIT_EXCEEDED/)
})
it('counts serialized UTF8 bytes at the exact entry limit, including Chinese', () => {
  const row = draft('中')
  row.input += 'x'.repeat(EDITING_ENTRY_BYTES - Buffer.byteLength(JSON.stringify(row)))
  expect(Buffer.byteLength(JSON.stringify(row))).toBe(2 * 1024 * 1024)
  expect(parseEditingDocument(doc([row])).drafts[0].input).toBe(row.input)
  expect(() => parseEditingDocument(doc([{ ...row, input: row.input + '中' }]))).toThrow(/LIMIT_EXCEEDED/)
})
it('rejects the document byte limit independently of valid entry sizes', () => {
  const row = draft('x'.repeat(EDITING_ENTRY_BYTES - 1024))
  const rows = Array.from({ length: 17 }, () => ({ ...row, id: randomUUID() }))
  expect(Buffer.byteLength(JSON.stringify(doc(rows)))).toBeGreaterThan(EDITING_MAX_BYTES)
  expect(() => parseEditingDocument(doc(rows))).toThrow(/LIMIT_EXCEEDED/)
})
it('does not treat a newer version or mismatched commit group as an empty document', () => {
  expect(() => parseEditingDocument({ schemaVersion: 2, revision: 0, drafts: [] })).toThrow(/UNSUPPORTED_VERSION/)
  const row = draft()
  expect(() => parseEditingDocument(doc([{ ...row, intent: { commitId: randomUUID(), draftIds: [randomUUID()], base: row.base, result: { notes: 'new' }, preparedAt: row.updatedAt } }]))).toThrow()
})
