import { afterEach, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { savePack } from '../../../electron/library/research/packService'
import { serializeResearchPack } from '../../../electron/library/research/export'
import { updateEvidence } from '../../../electron/library/evidence/service'
import { fields } from '../libraryEvidence/fixtures'
import { materialFixture } from './fixtures'
const fixtures: ReturnType<typeof materialFixture>[] = []
const setup = (n = 2) => { const f = materialFixture(n); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('A_B_AAndEmptySectionsHaveStableOrder，重复引用保留但唯一卡片数不重复', () => {
  const f = setup(4)
  const names = ['A', 'B', 'A', '']
  f.packInput.items.forEach((i, n) => { i.section = names[n]!; i.note = `item-${n}` })
  const p = savePack(f.ctx, { input: f.packInput, expectedRevision: 4, expectedEvidenceRevision: 1 })
  const result = serializeResearchPack(f.ctx, { packId: p.pack.id, packVersion: 1 }), md = result.utf8.toString('utf8')
  expect(result.preview.entryCount).toBe(4); expect(result.preview.uniqueCardCount).toBe(1)
  expect(md.indexOf('item-0')).toBeLessThan(md.indexOf('item-2'))
  expect(md.indexOf('item-2')).toBeLessThan(md.indexOf('item-1'))
  expect(md.indexOf('item-1')).toBeLessThan(md.indexOf('item-3'))
  expect(md).toContain('未指定小节')
  expect(result.preview.markdown).toBe(md)
})
it('markdownEscapesImagesAndHtmlWithoutTruncatingQuote，草稿/反对判断不丢', () => {
  const f = setup(1), quote = '  <script>no</script> ![img](https://remote)\n' + '😀'.repeat(400) + '\n\n'
  updateEvidence(f.ctx, f.cards[0]!.id, { ...fields(), quote, relation: 'opposes' }, 1)
  const p = savePack(f.ctx, { input: f.packInput, expectedRevision: 1, expectedEvidenceRevision: 2 })
  const result = serializeResearchPack(f.ctx, { packId: p.pack.id, packVersion: 1 })
  expect(result.preview.markdown).toContain('😀'.repeat(400))
  expect(result.preview.markdown).toContain('&lt;script&gt;')
  expect(result.preview.markdown).not.toContain('![img](')
  expect(result.preview.markdown).toContain('反对')
  expect(result.preview.markdown).toContain('草稿')
  expect(result.preview.markdown).toContain('未绑定')
})
it('missingPinnedHistoryBlocksExport，组织详情可见但不能伪造缺失正文', () => {
  const f = setup(), p = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  writeFileSync(join(f.root, '.mimir/library/evidence.json'), JSON.stringify({ schemaVersion: 1, revision: 1, cards: [] }))
  expect(() => serializeResearchPack(f.ctx, { packId: p.pack.id, packVersion: 1 })).toThrow(/REFERENCE_UNRESOLVED/)
})
