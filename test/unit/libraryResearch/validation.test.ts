import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { assertResearchBytes, parseResearchDocument, ResearchError } from '../../../electron/library/research/validation'
import { document, item, pack, question } from './fixtures'

it('严格合同完整往返且不修改输入', () => {
  const doc = document(), before = JSON.stringify(doc)
  expect(parseResearchDocument(doc)).toEqual(doc)
  expect(JSON.stringify(doc)).toBe(before)
  expect(() => parseResearchDocument({ ...doc, path: 'C:/anything' })).toThrow(ResearchError)
})
it('实际16MiB边界按字节校验', () => {
  expect(() => assertResearchBytes({ byteLength: 16 * 1024 * 1024 })).not.toThrow()
  expect(() => assertResearchBytes({ byteLength: 16 * 1024 * 1024 + 1 })).toThrow(/LIMIT_EXCEEDED/)
})
it.each(['question', 'pack'] as const)('容量包含归档%s且限额边界允许', kind => {
  const doc = document()
  if (kind === 'question') doc.questions = Array.from({ length: 200 }, () => { const q = question(); q.versions[0]!.archived = true; return q })
  else doc.packs = Array.from({ length: 100 }, () => { const p = pack(); p.versions[0]!.archived = true; return p })
  expect(() => parseResearchDocument(doc)).not.toThrow()
  if (kind === 'question') doc.questions.push(question())
  else doc.packs.push(pack())
  expect(() => parseResearchDocument(doc)).toThrow(/LIMIT_EXCEEDED/)
})
it('每个问题500关联与素材500条目，包括历史版本', () => {
  const doc = document(), q = doc.questions[0]!, p = doc.packs[0]!
  q.versions[0]!.evidenceCardIds = Array.from({ length: 500 }, () => randomUUID())
  p.versions[0]!.items = Array.from({ length: 500 }, item)
  expect(() => parseResearchDocument(doc)).not.toThrow()
  q.versions[0]!.evidenceCardIds.push(randomUUID())
  expect(() => parseResearchDocument(doc)).toThrow(/LIMIT_EXCEEDED/)
  q.versions[0]!.evidenceCardIds.pop()
  p.versions[0]!.items.push(item())
  expect(() => parseResearchDocument(doc)).toThrow(/LIMIT_EXCEEDED/)
})
it('Unicode字段按码点，不是UTF16单位；严格限制标题/说明/小节', () => {
  const doc = document(), q = doc.questions[0]!.versions[0]!, p = doc.packs[0]!.versions[0]!
  q.title = '😀'.repeat(200); q.question = '字'.repeat(2000); p.items[0]!.section = '😀'.repeat(200)
  expect(() => parseResearchDocument(doc)).not.toThrow()
  q.title += '😀'
  expect(() => parseResearchDocument(doc)).toThrow()
  q.title = '问题'; q.note = '字'.repeat(2001)
  expect(() => parseResearchDocument(doc)).toThrow()
  q.note = ''; p.items[0]!.section += '字'
  expect(() => parseResearchDocument(doc)).toThrow()
})
it('重复实体、关系与条目ID均拒绝；一卡可在不同问题重复引用', () => {
  const doc = document(), p = doc.packs[0]!.versions[0]!, first = p.items[0]!
  p.items.push({ ...first, id: randomUUID(), questionId: randomUUID() })
  expect(() => parseResearchDocument(doc)).not.toThrow()
  p.items[1]!.questionId = first.questionId
  expect(() => parseResearchDocument(doc)).toThrow()
  p.items[1]!.questionId = randomUUID(); p.items[1]!.id = first.id
  expect(() => parseResearchDocument(doc)).toThrow()
  p.items.pop(); doc.questions.push(structuredClone(doc.questions[0]!))
  expect(() => parseResearchDocument(doc)).toThrow()
})
it('非法版本、日期、UUID及项目更换拒绝', () => {
  const doc = document(), q = doc.questions[0]!
  q.versions.push({ ...q.versions[0]!, version: 2, projectId: 'other' }); q.currentVersion = 2
  expect(() => parseResearchDocument(doc)).toThrow()
  q.versions[1]!.projectId = 'project-1'; q.versions[1]!.version = 3
  expect(() => parseResearchDocument(doc)).toThrow()
  q.versions[1]!.version = 2; q.createdAt = 'bad'
  expect(() => parseResearchDocument(doc)).toThrow()
  q.createdAt = '2026-10-18T00:00:00.000Z'; q.id = '../escape'
  expect(() => parseResearchDocument(doc)).toThrow()
})
it('较新格式与损坏内容有明确不同错误，失联引用本身不破坏结构', () => {
  expect(() => parseResearchDocument({ ...document(), schemaVersion: 2 })).toThrow(/FORMAT_UNSUPPORTED/)
  expect(() => parseResearchDocument({ schemaVersion: 1 })).toThrow(/CORRUPT_DATA/)
  const doc = document(); doc.questions = []
  expect(() => parseResearchDocument(doc)).not.toThrow()
})
