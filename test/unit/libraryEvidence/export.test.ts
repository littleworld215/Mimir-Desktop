import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEvidenceExportWriter, serializeEvidenceExport } from '../../../electron/library/evidence/export'
import { document as evidenceDocument, fixture, version } from './fixtures'
const filter = { archive: 'exclude' as const, source: 'all' as const }
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('JSON全历史逐字段保真；按当前引用筛选而不再过滤历史版本', () => {
  const doc = evidenceDocument(), card = doc.cards[0]!
  card.currentVersion = 2; card.versions.push({ ...version(), version: 2, projectIds: ['new-project'], quote: ' \n😀\n' })
  const before = structuredClone(doc), result = serializeEvidenceExport(doc, { ...filter, projectId: 'new-project' }, 'json')
  expect(JSON.parse(result.utf8.toString('utf8')).cards[0].versions).toEqual(card.versions)
  expect(result).toMatchObject({ cardCount: 1, versionCount: 2 }); expect(doc).toEqual(before)
})
it.each(['=1+1', '+cmd', '-2+3', '@SUM(A1)', ' \t=1', '\r@cmd'])('CSV公式%s加安全前缀，只改导出表示并完整转义', value => {
  const doc = evidenceDocument(); doc.cards[0]!.versions[0]!.quote = value + '\n"原文"'
  const before = structuredClone(doc), result = serializeEvidenceExport(doc, filter, 'csv')
  expect(result.utf8.toString('utf8')).toContain(`"'${value}\n""原文"""`)
  expect(doc).toEqual(before)
})
it('Markdown转义HTML/图片/链接，JSON不加CSV前缀', () => {
  const doc = evidenceDocument(); doc.cards[0]!.versions[0]!.quote = '<script>x</script> ![图](https://example.org/img) [链接](javascript:bad())'
  const output = serializeEvidenceExport(doc, filter, 'markdown').utf8.toString('utf8')
  expect(output).not.toContain('<script>'); expect(output).not.toContain('![图]('); expect(output).not.toContain('[链接](')
  expect(output).toContain('&lt;script&gt;')
  expect(JSON.parse(serializeEvidenceExport(doc, filter, 'json').utf8.toString()).cards[0].versions[0].quote).toBe(doc.cards[0]!.versions[0]!.quote)
})
it.each(['write', 'sync', 'close'] as const)('新导出%s失败只清理自己文件；已有文件永不覆盖', fault => {
  const f = fixture(); fixtures.push(f)
  const output = join(f.root, 'export.csv'), existing = join(f.root, 'existing.csv')
  writeFileSync(existing, '用户资料')
  const writer = createEvidenceExportWriter({ [fault]: () => { throw Error('synthetic') } })
  expect(() => writer(output, Buffer.from('证据'))).toThrow(/WRITE_FAILED/)
  expect(existsSync(output)).toBe(false)
  expect(() => createEvidenceExportWriter()(existing, Buffer.from('覆盖'))).toThrow(/WRITE_FAILED/)
  expect(readFileSync(existing, 'utf8')).toBe('用户资料')
})
