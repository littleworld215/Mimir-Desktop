import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { EvidenceVersion, SourceInspection, SourceOpenResult } from '../../../shared/libraryEvidenceContracts'
import { paperPdfFileName } from '../arxiv'
import type { PaperRecord } from '../types'
import { assertEvidenceContext, evidenceDetail, reviseEvidence, type EvidenceContext } from './service'
import { assertRevision, EvidenceError } from './validation'

const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

/** 与PDF协议共用：只允许当前文献在当前空间papers目录的标准文件，不跟随链接。 */
export function resolveManagedPaperPdf(root: string, paper: PaperRecord): string {
  const base = resolve(root), directory = join(base, 'papers'), expected = join(directory, paperPdfFileName(paper.arxivId))
  if (!paper.pdfPath) throw new EvidenceError('SOURCE_MISSING', '请先下载来源PDF')
  if (!isAbsolute(paper.pdfPath) || !samePath(paper.pdfPath, expected)) throw new EvidenceError('SOURCE_UNAUTHORIZED', '仅支持当前空间受管PDF')
  try {
    const canonical = realpathSync.native(base)
    for (const path of [base, directory, expected]) {
      const info = lstatSync(path)
      if (info.isSymbolicLink() || (path === expected ? !info.isFile() : !info.isDirectory())) throw new EvidenceError('SOURCE_UNAUTHORIZED', '来源包含链接或类型异常')
      const rel = relative(canonical, realpathSync.native(path))
      if (rel.startsWith('..') || isAbsolute(rel)) throw new EvidenceError('SOURCE_UNAUTHORIZED', '来源越界')
    }
    return expected
  } catch (error) {
    if (error instanceof EvidenceError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new EvidenceError('SOURCE_MISSING', '来源PDF缺失')
    throw new EvidenceError('SOURCE_UNAUTHORIZED', '来源PDF不可读取')
  }
}
function selectedVersion(ctx: EvidenceContext, id: string, version: number): EvidenceVersion {
  const { card } = evidenceDetail(ctx, id)
  if (!Number.isSafeInteger(version) || version < 1 || version > card.versions.length) throw new EvidenceError('BAD_REQUEST', '证据版本不存在')
  return card.versions[version - 1]!
}
function currentPaper(ctx: EvidenceContext, version: EvidenceVersion): PaperRecord {
  assertEvidenceContext(ctx)
  const paper = ctx.catalog.papers().find(p => p.arxivId === version.paperId)
  if (!paper) throw new EvidenceError('SOURCE_MISSING', '来源文献已移除')
  return paper
}
async function digestSource(ctx: EvidenceContext, version: EvidenceVersion, hooks: { afterChunk?: () => Promise<void>; afterClose?: () => Promise<void> }) {
  const path = resolveManagedPaperPdf(ctx.scope.root, currentPaper(ctx, version)), initial = lstatSync(path)
  const handle = await open(path, 'r')
  let stream: ReturnType<typeof handle.createReadStream> | undefined
  try {
    assertEvidenceContext(ctx)
    if (!sameIdentity(initial, await handle.stat())) throw new EvidenceError('SOURCE_CHANGED', '摘要开始前来源变化')
    const hash = createHash('sha256')
    let header = Buffer.alloc(0), size = 0
    stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })
    for await (const chunk of stream) {
      assertEvidenceContext(ctx)
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (header.length < 5) header = Buffer.concat([header, bytes.subarray(0, 5 - header.length)])
      hash.update(bytes); size += bytes.length
      await hooks.afterChunk?.()
    }
    assertEvidenceContext(ctx)
    const latest = resolveManagedPaperPdf(ctx.scope.root, currentPaper(ctx, version))
    if (!samePath(path, latest) || !sameIdentity(initial, lstatSync(latest)) || !sameIdentity(initial, await handle.stat()) || size !== initial.size) throw new EvidenceError('SOURCE_CHANGED', '摘要期间来源变化，请重新检查')
    if (header.toString('ascii') !== '%PDF-') throw new EvidenceError('SOURCE_UNAUTHORIZED', '来源不是PDF文件')
    return { digest: { sha256: hash.digest('hex'), size, checkedAt: new Date().toISOString() }, revalidate: () => {
      assertEvidenceContext(ctx)
      const finalPath = resolveManagedPaperPdf(ctx.scope.root, currentPaper(ctx, version))
      if (!samePath(path, finalPath) || !sameIdentity(initial, lstatSync(finalPath))) throw new EvidenceError('SOURCE_CHANGED', '摘要收尾期间来源变化，请重新检查')
    } }
  } finally {
    stream?.destroy()
    await handle.close()
    await hooks.afterClose?.()
  }
}

/** 生命周期钩子仅为主进程真实文件测试端口，不能由renderer提交。 */
export function createEvidenceSourceService(hooks: { afterChunk?: () => Promise<void>; afterClose?: () => Promise<void> } = {}) {
  const observations = new Map<string, Map<string, SourceInspection>>()
  const scopeKey = (ctx: EvidenceContext) => JSON.stringify([ctx.scope.id, ctx.scope.epoch, ctx.scope.root])
  const record = (ctx: EvidenceContext, id: string, version: number, result: SourceInspection) => {
    assertEvidenceContext(ctx)
    const key = scopeKey(ctx), values = observations.get(key) ?? new Map<string, SourceInspection>()
    values.set(`${id}:${version}`, { ...result }); observations.set(key, values)
    return result
  }
  async function inspect(ctx: EvidenceContext, id: string, version: number): Promise<SourceInspection> {
    const selected = selectedVersion(ctx, id, version)
    let result: SourceInspection
    if (!ctx.catalog.papers().some(p => p.arxivId === selected.paperId)) result = { status: 'detached', checkedAt: new Date().toISOString() }
    else {
      try {
        const checked = await digestSource(ctx, selected, hooks)
        checked.revalidate()
        const digest = checked.digest
        const status = selected.documentBinding === null ? 'unbound' : selected.documentBinding.sha256 === digest.sha256 && selected.documentBinding.size === digest.size ? 'available' : 'changed'
        result = { status, ...digest }
      } catch (error) {
        assertEvidenceContext(ctx)
        if (!(error instanceof EvidenceError)) throw error
        if (!['SOURCE_CHANGED', 'SOURCE_MISSING', 'SOURCE_UNAUTHORIZED'].includes(error.code)) throw error
        result = { status: error.code === 'SOURCE_CHANGED' ? 'changed' : error.code === 'SOURCE_MISSING' ? 'missing' : 'unauthorized', checkedAt: new Date().toISOString() }
      }
    }
    return record(ctx, id, version, result)
  }
  return {
    sourceObservations: (ctx: EvidenceContext): ReadonlyMap<string, SourceInspection> => new Map([...(observations.get(scopeKey(ctx)) ?? [])].map(([key, value]) => [key, { ...value }])),
    clearSourceObservations: () => observations.clear(),
    inspectEvidenceSource: inspect,
    confirmEvidenceSource: async (ctx: EvidenceContext, id: string, expectedRevision: number) => {
      assertRevision(expectedRevision)
      const { document, card } = evidenceDetail(ctx, id)
      if (document.revision !== expectedRevision) throw new EvidenceError('CONFLICT', '证据已变化', document.revision)
      const previous = card.versions[card.currentVersion - 1]!, checked = await digestSource(ctx, previous, hooks)
      checked.revalidate()
      const digest = checked.digest
      if (previous.documentBinding !== null && (previous.documentBinding.sha256 !== digest.sha256 || previous.documentBinding.size !== digest.size)) throw new EvidenceError('SOURCE_CHANGED', '来源版本变化，保留旧卡，禁止自动重绑')
      assertEvidenceContext(ctx)
      const saved = reviseEvidence(ctx, id, expectedRevision, current => current.reviewState === 'checked' ? current : { ...current, reviewState: 'checked', documentBinding: digest })
      record(ctx, id, saved.card.currentVersion, { status: 'available', ...digest })
      return saved
    },
    openEvidenceSource: async (ctx: EvidenceContext, id: string, version: number): Promise<SourceOpenResult> => {
      const selected = selectedVersion(ctx, id, version), inspected = await inspect(ctx, id, version)
      assertEvidenceContext(ctx)
      return { status: inspected.status, checkedAt: inspected.checkedAt, locationMode: 'manual-page', requestedPage: selected.locator.pageStart,
        ...(['available', 'unbound'].includes(inspected.status) ? { pdfUrl: `mimir-pdf://paper/${paperPdfFileName(selected.paperId)}` } : {}) }
    }
  }
}
const sourceService = createEvidenceSourceService()
export const { sourceObservations, clearSourceObservations, inspectEvidenceSource, confirmEvidenceSource, openEvidenceSource } = sourceService
export function resolveEvidencePdfRequest(root: string, rawUrl: string, papers: readonly PaperRecord[]): string {
  try {
    const url = new URL(rawUrl), fileName = url.pathname.slice(1)
    if (url.protocol !== 'mimir-pdf:' || url.hostname !== 'paper' || url.username || url.password || url.port || url.search || url.hash || !fileName.endsWith('.pdf') || fileName.includes('/') || fileName.includes('\\')) throw Error('url')
    const id = decodeURIComponent(fileName.slice(0, -4))
    if (!id || id.includes('\0') || paperPdfFileName(id) !== fileName || rawUrl !== `mimir-pdf://paper/${fileName}`) throw Error('encoding')
    const paper = papers.find(p => p.arxivId === id)
    if (!paper) throw new EvidenceError('SOURCE_MISSING', '来源文献未登记')
    return resolveManagedPaperPdf(root, paper)
  } catch (error) {
    if (error instanceof EvidenceError) throw error
    throw new EvidenceError('SOURCE_UNAUTHORIZED', 'PDF协议地址非法')
  }
}
