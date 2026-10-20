import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertPlanningBytes, emptyPlanningDocument, parsePlanningDocument, parsePlanningDrafts, parsePlanningDeliveries, PlanningError } from './validation'
import type { PlanningDocument } from '../../shared/researchPlanningContracts'

type Filename = 'planning.json' | 'drafts.json' | 'deliveries.json'
type Hooks = Partial<Record<'write' | 'sync' | 'close' | 'rename', () => void>>
const stat = (path: string) => { try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
const same = (a: ReturnType<typeof lstatSync> | undefined, b: ReturnType<typeof lstatSync> | undefined) => !!a && !!b && !a.isSymbolicLink() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino
function pathFor(root: string, name: Filename, create = false) {
  const base = resolve(root), info = stat(base)
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new PlanningError('SOURCE_UNAUTHORIZED', '科研空间不可用')
  const canonical = realpathSync.native(base)
  let path = base
  for (const part of ['.mimir', 'planning', name]) {
    path = join(path, part)
    let entry = stat(path)
    if (!entry && create && part !== name) { mkdirSync(path); entry = lstatSync(path) }
    if (!entry) continue
    if (entry.isSymbolicLink() || (part === name ? !entry.isFile() : !entry.isDirectory())) throw new PlanningError('SOURCE_UNAUTHORIZED', '计划目录含链接或类型异常')
    const rel = relative(canonical, realpathSync.native(path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PlanningError('SOURCE_UNAUTHORIZED', '计划目录越界')
  }
  return path
}
/** 文件名为主进程固定白名单，不能来自renderer；三份文档各自维护revision。 */
function store<T extends { schemaVersion: 1; revision: number }>(name: Filename, parse: (value: unknown) => T, empty: () => T, hooks: Hooks) {
  function read(root: string): T {
    const path = pathFor(root, name), entry = stat(path)
    if (!entry) return empty()
    assertPlanningBytes(entry.size)
    let fd: number | undefined
    try {
      fd = openSync(path, 'r'); const opened = fstatSync(fd)
      if (!same(entry, opened) || !opened.isFile()) throw new PlanningError('SOURCE_UNAUTHORIZED', '读取期间来源变化')
      assertPlanningBytes(opened.size)
      const bytes = readFileSync(fd); assertPlanningBytes(bytes.length)
      pathFor(root, name)
      if (!same(opened, stat(path))) throw new PlanningError('SOURCE_UNAUTHORIZED', '读取期间来源变化')
      return parse(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if (error instanceof PlanningError) throw error
      throw new PlanningError('CORRUPT_DATA', '计划数据不可读，原文件已保留')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  return { read, commit(root: string, expected: number, input: T, beforePublish: () => void = () => {}) {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new PlanningError('BAD_REQUEST')
    const previous = read(root)
    if (previous.revision !== expected) throw new PlanningError('CONFLICT', '已有更新，请保留输入后重新加载', previous.revision)
    const next = parse(input)
    if (next.revision !== expected + 1) throw new PlanningError('BAD_REQUEST', '修订必须递增')
    if (name === 'planning.json') {
      const prior = previous as unknown as PlanningDocument, after = next as unknown as PlanningDocument
      for (const key of ['items', 'types', 'collections'] as const) if (prior[key].some(old => !after[key].some(v => v.id === old.id))) throw new PlanningError('BAD_REQUEST', '请移入回收站，不可移除持久记录')
      for (const old of prior.items) { const value = after.items.find(v => v.id === old.id)!; if (value.createdAt !== old.createdAt || value.kind !== old.kind) throw new PlanningError('BAD_REQUEST', '记录身份不可修改') }
    }
    const bytes = Buffer.from(JSON.stringify(next), 'utf8'); assertPlanningBytes(bytes.length)
    const path = pathFor(root, name, true), folder = dirname(path), parent = lstatSync(folder), temp = `${path}.${randomUUID()}.partial`
    let fd: number | undefined, owned: ReturnType<typeof fstatSync> | undefined, published = false
    try {
      fd = openSync(temp, 'wx', 0o600); owned = fstatSync(fd)
      hooks.write?.(); writeFileSync(fd, bytes)
      hooks.sync?.(); fsyncSync(fd)
      hooks.close?.(); closeSync(fd); fd = undefined
      beforePublish()
      if (JSON.stringify(read(root)) !== JSON.stringify(previous)) throw new PlanningError('CONFLICT', '保存期间计划已变化')
      hooks.rename?.(); pathFor(root, name)
      if (!same(stat(folder), parent) || !same(stat(temp), owned)) throw new PlanningError('WRITE_FAILED', '临时文件或目录已变化，拒绝发布')
      renameSync(temp, path); published = true
      return next
    } catch (error) {
      if (error instanceof PlanningError) throw error
      throw new PlanningError('WRITE_FAILED', '未保存，请保留输入并检查磁盘')
    } finally {
      let failed = false
      if (fd !== undefined) { try { closeSync(fd) } catch { failed = true } }
      if (!published && owned) { try { const entry = stat(temp); if (entry && same(entry, owned) && same(stat(folder), parent)) unlinkSync(temp); else if (entry) failed = true } catch { failed = true } }
      if (failed) throw new PlanningError('WRITE_FAILED', '临时文件无法安全清理，原资料保留')
    }
  } }
}
export const createPlanningRepository = (hooks: Hooks = {}) => store('planning.json', parsePlanningDocument, emptyPlanningDocument, hooks)
export const createPlanningDraftRepository = (hooks: Hooks = {}) => store('drafts.json', parsePlanningDrafts, () => ({ schemaVersion: 1, revision: 0, drafts: [] }), hooks)
export const createPlanningDeliveryRepository = (hooks: Hooks = {}) => store('deliveries.json', parsePlanningDeliveries, () => ({ schemaVersion: 1, revision: 0, deliveries: [] }), hooks)
