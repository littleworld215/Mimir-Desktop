import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve, isAbsolute } from 'node:path'
import type { EvidenceDocument } from '../../../shared/libraryEvidenceContracts'
import { assertEvidenceBytes, assertRevision, EvidenceError, parseEvidenceDocument } from './validation'

function stat(path: string) {
  try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export function evidencePath(root: string, create = false): string {
  const base = resolve(root), rootStat = stat(base)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new EvidenceError('SOURCE_UNAUTHORIZED', '空间根目录不可用')
  const canonical = realpathSync.native(base)
  let current = base
  for (const name of ['.mimir', 'library', 'evidence.json']) {
    current = join(current, name)
    let info = stat(current)
    if (!info && create && name !== 'evidence.json') { mkdirSync(current); info = lstatSync(current) }
    if (!info) continue
    if (info.isSymbolicLink() || (name === 'evidence.json' ? !info.isFile() : !info.isDirectory())) throw new EvidenceError('SOURCE_UNAUTHORIZED', '证据路径含链接或类型异常')
    const rel = relative(canonical, realpathSync.native(current))
    if (rel.startsWith('..') || isAbsolute(rel)) throw new EvidenceError('SOURCE_UNAUTHORIZED', '证据路径越界')
  }
  return current
}
function read(root: string): EvidenceDocument {
  const path = evidencePath(root)
  if (!stat(path)) return { schemaVersion: 1, revision: 0, cards: [] }
  assertEvidenceBytes({ byteLength: lstatSync(path).size })
  try {
    const bytes = readFileSync(path)
    assertEvidenceBytes(bytes)
    return parseEvidenceDocument(JSON.parse(bytes.toString('utf8')))
  }
  catch (error) { if (error instanceof EvidenceError) throw error; throw new EvidenceError('CORRUPT_DATA', '证据文件无法读取，原文件已保留') }
}
function assertAppendOnly(previous: EvidenceDocument, next: EvidenceDocument): void {
  if (next.revision !== previous.revision + 1) throw new EvidenceError('BAD_REQUEST', '提交版本必须递增')
  const cards = new Map(next.cards.map(card => [card.id, card]))
  for (const old of previous.cards) {
    const card = cards.get(old.id)
    if (!card || card.createdAt !== old.createdAt || card.versions.length < old.versions.length || old.versions.some((v, i) => JSON.stringify(v) !== JSON.stringify(card.versions[i]))) throw new EvidenceError('BAD_REQUEST', '历史证据只增不改，请归档而非删除')
  }
}
type FaultHooks = Partial<Record<'write' | 'sync' | 'close' | 'rename', () => void>>
/** 故障钩子仅供主进程单测；真实I/O始终由仓库执行，不能由renderer传入。 */
export function createEvidenceRepository(hooks: FaultHooks = {}) {
  return { read, commit(root: string, expectedRevision: number, input: EvidenceDocument, beforePublish: () => void = () => {}): EvidenceDocument {
    assertRevision(expectedRevision)
    const previous = read(root)
    if (previous.revision !== expectedRevision) throw new EvidenceError('CONFLICT', '证据已变化，请保留输入并重新加载', previous.revision)
    const next = parseEvidenceDocument(input)
    assertAppendOnly(previous, next)
    const bytes = Buffer.from(JSON.stringify(next), 'utf8')
    assertEvidenceBytes(bytes)
    const path = evidencePath(root, true), temp = `${path}.${randomUUID()}.partial`
    let fd: number | undefined, owned: ReturnType<typeof fstatSync> | undefined, published = false
    try {
      fd = openSync(temp, 'wx', 0o600); owned = fstatSync(fd)
      hooks.write?.(); writeFileSync(fd, bytes)
      hooks.sync?.(); fsyncSync(fd)
      hooks.close?.(); closeSync(fd); fd = undefined
      beforePublish()
      if (read(root).revision !== expectedRevision) throw new EvidenceError('CONFLICT', '保存期间证据已变化')
      evidencePath(root)
      hooks.rename?.(); renameSync(temp, path)
      published = true
      return next
    } catch (error) {
      if (error instanceof EvidenceError) throw error
      throw new EvidenceError('WRITE_FAILED', '证据未保存，请保留输入并重试')
    } finally {
      let failed = false
      if (fd !== undefined) { try { closeSync(fd) } catch { failed = true } }
      if (!published && owned) {
        try {
          const info = stat(temp)
          if (info && !info.isSymbolicLink() && info.dev === owned.dev && info.ino === owned.ino) unlinkSync(temp)
          else if (info) failed = true
        } catch { failed = true }
      }
      if (failed) throw new EvidenceError('WRITE_FAILED', '未保存且临时文件清理失败；原证据保留，请检查本机磁盘')
    }
  } }
}
const repository = createEvidenceRepository()
export const readEvidence = repository.read
export const commitEvidence = repository.commit
