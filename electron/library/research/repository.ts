import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ResearchDocument } from '../../../shared/libraryResearchContracts'
import { assertResearchBytes, assertResearchRevision, parseResearchDocument, ResearchError } from './validation'

function stat(path: string) {
  try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
const sameFile = (a: ReturnType<typeof lstatSync> | undefined, b: ReturnType<typeof lstatSync>) => Boolean(a && b && !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino)
export function researchPath(root: string, create = false): string {
  const base = resolve(root), info = stat(base)
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new ResearchError('SOURCE_UNAUTHORIZED', '科研空间根目录不可用')
  const canonical = realpathSync.native(base)
  let current = base
  for (const name of ['.mimir', 'library', 'research.json']) {
    current = join(current, name)
    let entry = stat(current)
    if (!entry && create && name !== 'research.json') { mkdirSync(current); entry = lstatSync(current) }
    if (!entry) continue
    if (entry.isSymbolicLink() || (name === 'research.json' ? !entry.isFile() : !entry.isDirectory())) throw new ResearchError('SOURCE_UNAUTHORIZED', '研究组织路径含链接或类型异常')
    const rel = relative(canonical, realpathSync.native(current))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ResearchError('SOURCE_UNAUTHORIZED', '研究组织路径越界')
  }
  return current
}
function read(root: string): ResearchDocument {
  const path = researchPath(root), info = stat(path)
  if (!info) return { schemaVersion: 1, revision: 0, questions: [], packs: [] }
  assertResearchBytes({ byteLength: info.size })
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const opened = fstatSync(fd)
    if (!sameFile(opened, info) || !opened.isFile()) throw new ResearchError('SOURCE_UNAUTHORIZED', '研究文件读取期间已变化')
    assertResearchBytes({ byteLength: opened.size })
    const bytes = readFileSync(fd)
    assertResearchBytes(bytes)
    researchPath(root)
    if (!sameFile(stat(path), opened)) throw new ResearchError('SOURCE_UNAUTHORIZED', '研究文件读取期间已变化')
    return parseResearchDocument(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    if (error instanceof ResearchError) throw error
    throw new ResearchError('CORRUPT_DATA', '研究组织无法读取，原文件已保留')
  } finally { if (fd !== undefined) closeSync(fd) }
}
function assertAppendOnly(previous: ResearchDocument, next: ResearchDocument): void {
  if (next.revision !== previous.revision + 1) throw new ResearchError('BAD_REQUEST', '研究提交修订必须递增')
  for (const key of ['questions', 'packs'] as const) {
    const entities = new Map(next[key].map(entity => [entity.id, entity] as const))
    for (const old of previous[key]) {
      const entity = entities.get(old.id)
      if (!entity || entity.createdAt !== old.createdAt || entity.versions.length < old.versions.length || old.versions.some((v, i) => JSON.stringify(v) !== JSON.stringify(entity.versions[i]))) throw new ResearchError('BAD_REQUEST', '研究组织历史只增不改，请归档而非删除')
    }
  }
}
type FaultHooks = Partial<Record<'write' | 'sync' | 'close' | 'rename', () => void>>
/** 故障端口仅供真实I/O回归，绝不放入renderer契约。 */
export function createResearchRepository(hooks: FaultHooks = {}) {
  return { read, commit(root: string, expectedRevision: number, input: ResearchDocument, beforePublish: () => void = () => {}): ResearchDocument {
    assertResearchRevision(expectedRevision)
    const previous = read(root)
    if (previous.revision !== expectedRevision) throw new ResearchError('CONFLICT', '研究组织已有更新，请保留输入并重新加载', previous.revision)
    const next = parseResearchDocument(input)
    assertAppendOnly(previous, next)
    const bytes = Buffer.from(JSON.stringify(next), 'utf8')
    assertResearchBytes(bytes)
    const path = researchPath(root, true), directory = dirname(path), parent = lstatSync(directory), temp = `${path}.${randomUUID()}.partial`
    let fd: number | undefined, owned: ReturnType<typeof fstatSync> | undefined, published = false
    try {
      fd = openSync(temp, 'wx', 0o600); owned = fstatSync(fd)
      hooks.write?.(); writeFileSync(fd, bytes)
      hooks.sync?.(); fsyncSync(fd)
      hooks.close?.(); closeSync(fd); fd = undefined
      beforePublish()
      if (read(root).revision !== expectedRevision) throw new ResearchError('CONFLICT', '保存期间研究组织已变化')
      hooks.rename?.()
      researchPath(root)
      if (!sameFile(stat(directory), parent) || !sameFile(stat(temp), owned)) throw new ResearchError('WRITE_FAILED', '保存期间目录或临时文件已变化，拒绝发布')
      renameSync(temp, path)
      published = true
      return next
    } catch (error) {
      if (error instanceof ResearchError) throw error
      throw new ResearchError('WRITE_FAILED', '研究组织未保存，请保留输入并检查磁盘')
    } finally {
      let failed = false
      if (fd !== undefined) { try { closeSync(fd) } catch { failed = true } }
      if (!published && owned) {
        try {
          const entry = stat(temp)
          if (entry && sameFile(entry, owned) && sameFile(stat(directory), parent)) unlinkSync(temp)
          else if (entry) failed = true
        } catch { failed = true }
      }
      if (failed) throw new ResearchError('WRITE_FAILED', '未保存且临时文件无法安全清理，原资料保留；请检查本机磁盘')
    }
  } }
}
const repository = createResearchRepository()
export const readResearch = repository.read
export const commitResearch = repository.commit
