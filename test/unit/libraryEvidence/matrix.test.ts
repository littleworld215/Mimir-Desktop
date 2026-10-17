import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { deriveEvidenceMatrix } from '../../../electron/library/evidence/matrix'
import type { PaperRecord } from '../../../electron/library/types'
import { document as evidenceDocument, version } from './fixtures'
const filter = { archive: 'exclude' as const, source: 'all' as const }
const paper = (id: string): PaperRecord => ({ arxivId: id, title: `文献${id}`, authors: [], summary: '', url: '', notes: '', tags: [], projectIds: ['p1'], addedAt: '' })

it('51篇过滤后分页；十篇各两卡保留支持与反对，不混合判断', () => {
  const papers = Array.from({ length: 51 }, (_, i) => paper(String(i).padStart(2, '0')))
  const doc = evidenceDocument(); doc.cards = []
  for (const p of papers.slice(0, 10)) for (const relation of ['supports', 'opposes'] as const) doc.cards.push({ id: randomUUID(), createdAt: version().updatedAt, currentVersion: 1, versions: [{ ...version(), paperId: p.arxivId, paperSnapshot: { id: p.arxivId, title: p.title, authors: [], url: '' }, projectIds: ['p1'], relation }] })
  const first = deriveEvidenceMatrix(doc, papers, [{ id: 'p1' }], filter, 1, new Map()), second = deriveEvidenceMatrix(doc, papers, [{ id: 'p1' }], filter, 2, new Map())
  expect(first.rows).toHaveLength(50); expect(second.rows).toHaveLength(1); expect(first.total).toBe(51)
  expect(first.rows.slice(0, 10).map(row => row.cards.map(c => c.relation).sort())).toEqual(Array.from({ length: 10 }, () => ['opposes', 'supports']))
})
it('失联文献保留快照行、失效项目不自动重归类；异常筛选不假定未检查来源已验证', () => {
  const doc = evidenceDocument(), card = doc.cards[0]!
  const all = deriveEvidenceMatrix(doc, [], [], filter, 1, new Map())
  expect(all.rows[0]).toMatchObject({ missingPaper: true, missingProjectIds: ['project-1'], paperSnapshot: card.versions[0]!.paperSnapshot })
  expect(deriveEvidenceMatrix(doc, [], [], { ...filter, source: 'problem' }, 1, new Map()).rows).toHaveLength(1)
  expect(deriveEvidenceMatrix(doc, [paper(card.versions[0]!.paperId)], [], { ...filter, source: 'problem' }, 1, new Map()).rows).toHaveLength(0)
  expect(deriveEvidenceMatrix(doc, [], [], { ...filter, projectId: 'other' }, 1, new Map()).rows).toHaveLength(0)
  const observations = new Map([[`${card.id}:1`, { status: 'changed' as const, checkedAt: '2026-10-17T10:00:00.000Z' }]])
  expect(deriveEvidenceMatrix(doc, [paper(card.versions[0]!.paperId)], [], { ...filter, source: 'problem' }, 1, observations).rows[0]!.cards[0]).toMatchObject({ sourceStatus: 'changed', checkedAt: '2026-10-17T10:00:00.000Z' })
})
it('完整内容参与关键词，预览200码点不回写；草稿/归档过滤一致', () => {
  const doc = evidenceDocument(), before = structuredClone(doc), v = doc.cards[0]!.versions[0]!
  v.finding = '😀'.repeat(201) + '尾部命中'; before.cards[0]!.versions[0]!.finding = v.finding
  const result = deriveEvidenceMatrix(doc, [], [], { ...filter, keyword: '尾部命中' }, 1, new Map())
  expect(Array.from(result.rows[0]!.cards[0]!.finding)).toHaveLength(200)
  expect(doc).toEqual(before)
  expect(deriveEvidenceMatrix(doc, [], [], { ...filter, reviewState: 'checked' }, 1, new Map()).rows).toHaveLength(0)
  v.archived = true
  expect(deriveEvidenceMatrix(doc, [], [], filter, 1, new Map()).rows).toHaveLength(0)
  expect(deriveEvidenceMatrix(doc, [], [], { ...filter, archive: 'only' }, 1, new Map()).rows).toHaveLength(1)
})
