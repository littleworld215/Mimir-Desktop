import { afterEach, expect, it } from 'vitest'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paperPdfFileName } from '../../../electron/library/arxiv'
import { createEvidence, updateEvidence, type EvidenceContext } from '../../../electron/library/evidence/service'
import { createEvidenceSourceService } from '../../../electron/library/evidence/source'
import { fields, fixture } from './fixtures'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it.each(['catalog', 'replace'])('所有异步关流结束后%s变化不得确认来源', async mode => {
  const f = fixture(); fixtures.push(f)
  const path = join(f.root, 'papers', paperPdfFileName(fields().paperId))
  mkdirSync(join(f.root, 'papers')); writeFileSync(path, '%PDF-1.4\nsynthetic')
  const paper = { ...f.ctx.catalog.papers()[0]!, pdfPath: path }
  const ctx = { ...f.ctx, catalog: { ...f.ctx.catalog, papers: () => [paper] } }
  const created = createEvidence(ctx, fields(), 0), before = readFileSync(join(f.root, '.mimir/library/evidence.json'))
  const source = createEvidenceSourceService({ afterClose: async () => {
    if (mode === 'catalog') ctx.catalog.papers = () => []
    else { renameSync(path, `${path}.old`); writeFileSync(path, '%PDF-1.4\nnew-file') }
  } } as any)
  await expect(source.confirmEvidenceSource(ctx, created.card.id, 1)).rejects.toThrow(/SOURCE_MISSING|SOURCE_CHANGED/)
  expect(readFileSync(join(f.root, '.mimir/library/evidence.json'))).toEqual(before)
  expect(source.sourceObservations(ctx).size).toBe(0)
})
it.each(['replace', 'rewrite', 'scope', 'cancel', 'revision', 'catalog'])('摘要等待期间%s变化不发布来源绑定', async mode => {
  const f = fixture(); fixtures.push(f)
  const path = join(f.root, 'papers', paperPdfFileName(fields().paperId))
  mkdirSync(join(f.root, 'papers'))
  writeFileSync(path, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(256 * 1024, 65)]))
  const controller = new AbortController()
  let current = true, entered!: () => void, release!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const paper = { ...f.ctx.catalog.papers()[0]!, pdfPath: path }
  const ctx: EvidenceContext = { ...f.ctx, signal: controller.signal, assertCurrent: () => { if (!current) throw Error('SPACE_CHANGED') }, catalog: { ...f.ctx.catalog, papers: () => [paper] } }
  const created = createEvidence(ctx, fields(), 0)
  const source = createEvidenceSourceService({ afterChunk: async () => { entered(); await held } })
  const pending = source.confirmEvidenceSource(ctx, created.card.id, 1)
  // Attach rejection assertion before releasing to avoid unhandled-rejection noise.
  const rejected = expect(pending).rejects.toThrow(/SOURCE_CHANGED|SPACE_CHANGED|CANCELED|CONFLICT|SOURCE_MISSING/)
  await enteredPromise
  if (mode === 'replace') { renameSync(path, `${path}.original`); writeFileSync(path, '%PDF-1.4\nreplacement') }
  if (mode === 'rewrite') writeFileSync(path, '%PDF-1.4\nchanged')
  if (mode === 'scope') current = false
  if (mode === 'cancel') controller.abort()
  if (mode === 'revision') updateEvidence(ctx, created.card.id, { ...fields(), comment: '另一个窗口修订' }, 1)
  if (mode === 'catalog') ctx.catalog.papers = () => []
  const before = readFileSync(join(f.root, '.mimir/library/evidence.json'))
  release(); await rejected
  expect(readFileSync(join(f.root, '.mimir/library/evidence.json'))).toEqual(before)
  expect(source.sourceObservations(ctx).size).toBe(0)
})
