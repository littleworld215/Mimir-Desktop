import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paperPdfFileName } from '../../../electron/library/arxiv'
import { createEvidence, updateEvidence, type EvidenceContext } from '../../../electron/library/evidence/service'
import { createEvidenceSourceService, resolveManagedPaperPdf } from '../../../electron/library/evidence/source'
import { fields, fixture } from './fixtures'

const fixtures: ReturnType<typeof fixture>[] = []
export function setupPdf(id = fields().paperId) {
  const f = fixture(); fixtures.push(f)
  const path = join(f.root, 'papers', paperPdfFileName(id))
  mkdirSync(join(f.root, 'papers'))
  const bytes = Buffer.from('%PDF-1.4\n合成文献\n%%EOF')
  writeFileSync(path, bytes)
  const paper = { ...f.ctx.catalog.papers()[0]!, arxivId: id, pdfPath: path }
  const ctx: EvidenceContext = { ...f.ctx, catalog: { ...f.ctx.catalog, papers: () => [paper] } }
  const created = createEvidence(ctx, { ...fields(), paperId: id }, 0)
  return { ...f, ctx, path, bytes, paper, card: created.card, source: createEvidenceSourceService() }
}
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))

it('核对才绑定受管PDF，历史原文与笔记保留；再次核对无变化不增历史', async () => {
  const f = setupPdf(), before = readFileSync(join(f.root, '.mimir/library/evidence.json'))
  expect(f.source.sourceObservations(f.ctx).size).toBe(0)
  expect((await f.source.inspectEvidenceSource(f.ctx, f.card.id, 1)).status).toBe('unbound')
  expect(readFileSync(join(f.root, '.mimir/library/evidence.json'))).toEqual(before)
  const confirmed = await f.source.confirmEvidenceSource(f.ctx, f.card.id, 1)
  expect(confirmed.card.versions).toHaveLength(2)
  expect(confirmed.card.versions[0]).toEqual(f.card.versions[0])
  expect(confirmed.card.versions[1]).toMatchObject({ reviewState: 'checked', documentBinding: { sha256: createHash('sha256').update(f.bytes).digest('hex'), size: f.bytes.length } })
  expect((await f.source.confirmEvidenceSource(f.ctx, f.card.id, 2)).document.revision).toBe(2)
  expect(f.paper.notes).toBe('旧笔记')
  const opened = await f.source.openEvidenceSource(f.ctx, f.card.id, 2)
  expect(opened).toMatchObject({ status: 'available', pdfUrl: `mimir-pdf://paper/${paperPdfFileName(f.paper.arxivId)}`, requestedPage: 1, locationMode: 'manual-page' })
  expect(JSON.stringify(opened)).not.toContain(f.root)
})
it('同名PDF变化可见，禁止自动重绑；旧版本仍可检查但不冒充定位成功', async () => {
  const f = setupPdf(); await f.source.confirmEvidenceSource(f.ctx, f.card.id, 1)
  const before = readFileSync(join(f.root, '.mimir/library/evidence.json'))
  writeFileSync(f.path, '%PDF-1.4\n替代文献\n%%EOF')
  expect((await f.source.inspectEvidenceSource(f.ctx, f.card.id, 2)).status).toBe('changed')
  await expect(f.source.confirmEvidenceSource(f.ctx, f.card.id, 2)).rejects.toThrow(/SOURCE_CHANGED/)
  expect(await f.source.openEvidenceSource(f.ctx, f.card.id, 2)).toMatchObject({ status: 'changed', locationMode: 'manual-page' })
  expect((await f.source.openEvidenceSource(f.ctx, f.card.id, 2)).pdfUrl).toBeUndefined()
  expect(readFileSync(join(f.root, '.mimir/library/evidence.json'))).toEqual(before)
})
it.each(['missing', 'html', 'external', 'junction'])('来源异常%s阻止确认且不改证据', async mode => {
  const f = setupPdf(), before = readFileSync(join(f.root, '.mimir/library/evidence.json'))
  if (mode === 'missing') unlinkSync(f.path)
  if (mode === 'html') writeFileSync(f.path, '<html>无权限</html>')
  if (mode === 'external') f.paper.pdfPath = join(f.root, 'another.pdf')
  if (mode === 'junction') {
    const other = fixture(); fixtures.push(other)
    renameSync(join(f.root, 'papers'), join(f.root, 'oldpapers'))
    writeFileSync(join(other.root, paperPdfFileName(f.paper.arxivId)), f.bytes)
    symlinkSync(other.root, join(f.root, 'papers'), 'junction')
  }
  expect((await f.source.inspectEvidenceSource(f.ctx, f.card.id, 1)).status).toBe(mode === 'missing' ? 'missing' : 'unauthorized')
  await expect(f.source.confirmEvidenceSource(f.ctx, f.card.id, 1)).rejects.toThrow(/SOURCE_(MISSING|UNAUTHORIZED)/)
  expect(readFileSync(join(f.root, '.mimir/library/evidence.json'))).toEqual(before)
})
it('Unicode与旧式斜杠标识安全编码；共享解析器只认当前paper的受管文件', () => {
  const f = setupPdf('doi:10.1000/中文😀')
  expect(resolveManagedPaperPdf(f.root, f.paper)).toBe(f.path)
  expect(() => resolveManagedPaperPdf(f.root, { ...f.paper, pdfPath: join(f.root, 'papers/../outside.pdf') })).toThrow(/SOURCE_UNAUTHORIZED/)
})
it('移除/重导入不抹卡；新修订观察不沿用，观察按scope隔离并可清空', async () => {
  const f = setupPdf(); await f.source.confirmEvidenceSource(f.ctx, f.card.id, 1)
  f.ctx.catalog.papers = () => []
  expect((await f.source.inspectEvidenceSource(f.ctx, f.card.id, 2)).status).toBe('detached')
  await expect(f.source.confirmEvidenceSource(f.ctx, f.card.id, 2)).rejects.toThrow(/SOURCE_MISSING/)
  f.ctx.catalog.papers = () => [f.paper]
  expect((await f.source.inspectEvidenceSource(f.ctx, f.card.id, 2)).status).toBe('available')
  updateEvidence(f.ctx, f.card.id, { ...fields(), comment: '新判断' }, 2)
  expect(f.source.sourceObservations(f.ctx).has(`${f.card.id}:3`)).toBe(false)
  expect(f.source.sourceObservations({ ...f.ctx, scope: { ...f.ctx.scope, epoch: 'new' } }).size).toBe(0)
  f.source.clearSourceObservations()
  expect(f.source.sourceObservations(f.ctx).size).toBe(0)
})
