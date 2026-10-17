import { afterEach, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paperPdfFileName } from '../../../electron/library/arxiv'
import { resolveEvidencePdfRequest } from '../../../electron/library/evidence/source'
import { fixture } from './fixtures'
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('严格协议只返回当前受管PDF，包括旧式斜杠/Unicode；远程、穿越、参数、设备及未知文献拒绝', () => {
  const f = fixture(); fixtures.push(f)
  const id = 'doi:10.1/中文😀', filename = paperPdfFileName(id), path = join(f.root, 'papers', filename)
  mkdirSync(join(f.root, 'papers')); writeFileSync(path, '%PDF-1.4\n')
  const paper = { ...f.ctx.catalog.papers()[0]!, arxivId: id, pdfPath: path }
  expect(resolveEvidencePdfRequest(f.root, `mimir-pdf://paper/${filename}`, [paper])).toBe(path)
  for (const url of ['file:///C:/secret.pdf', 'https://example.org/a.pdf', 'mimir-pdf://paper/../secret.pdf', 'mimir-pdf://paper/%2e%2e%2fsecret.pdf', 'mimir-pdf://paper/a/b.pdf', 'mimir-pdf://evil/a.pdf', 'mimir-pdf://paper/CON.pdf', 'mimir-pdf://paper/unknown.pdf', `mimir-pdf://paper/${filename}?p=C:/secret`, `mimir-pdf://user@paper/${filename}`]) expect(() => resolveEvidencePdfRequest(f.root, url, [paper])).toThrow()
})
it('协议与摘要共享链接拒绝；没有paper授权不能单凭目录读取', () => {
  const f = fixture(), other = fixture(); fixtures.push(f, other)
  const id = f.ctx.catalog.papers()[0]!.arxivId, filename = paperPdfFileName(id)
  writeFileSync(join(other.root, filename), '%PDF-1.4\n')
  symlinkSync(other.root, join(f.root, 'papers'), 'junction')
  const paper = { ...f.ctx.catalog.papers()[0]!, pdfPath: join(f.root, 'papers', filename) }
  expect(() => resolveEvidencePdfRequest(f.root, `mimir-pdf://paper/${filename}`, [paper])).toThrow(/SOURCE_UNAUTHORIZED/)
  expect(() => resolveEvidencePdfRequest(f.root, `mimir-pdf://paper/${filename}`, [])).toThrow()
})
