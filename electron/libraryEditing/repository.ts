import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { EditingDocument } from '../../shared/libraryEditingContracts'
import { assertEditingBytes, EditingError, parseEditingDocument } from './validation'

type Hooks = Partial<Record<'write' | 'sync' | 'close' | 'rename' | 'afterRead', () => void>>
const stat = (path: string) => { try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
const same = (a: ReturnType<typeof lstatSync> | undefined, b: ReturnType<typeof lstatSync> | undefined) => !!a && !!b && !a.isSymbolicLink() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino
function pathFor(root: string, create = false) {
  const base = resolve(root), info = stat(base)
  if (!isAbsolute(root) || !info?.isDirectory() || info.isSymbolicLink()) throw new EditingError('SOURCE_UNAUTHORIZED', '科研空间不可用')
  const canonical = realpathSync.native(base)
  let path = base
  for (const part of ['.mimir', 'library-editing', 'drafts.json']) {
    path = join(path, part)
    let entry = stat(path)
    if (!entry && create && part !== 'drafts.json') { mkdirSync(path); entry = stat(path) }
    if (!entry) continue
    if (entry.isSymbolicLink() || (part === 'drafts.json' ? !entry.isFile() : !entry.isDirectory())) throw new EditingError('SOURCE_UNAUTHORIZED', '恢复草稿路径含链接或类型异常')
    const rel = relative(canonical, realpathSync.native(path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new EditingError('SOURCE_UNAUTHORIZED', '恢复草稿路径越界')
  }
  return path
}
export function createEditingRepository(hooks: Hooks = {}) {
  function load(root: string): { document: EditingDocument; signature: string } {
    const path = pathFor(root), entry = stat(path)
    if (!entry) return { document: { schemaVersion: 1, revision: 0, drafts: [] }, signature: 'missing' }
    assertEditingBytes(entry.size)
    let fd: number | undefined
    try {
      fd = openSync(path, 'r'); const opened = fstatSync(fd)
      if (!same(entry, opened) || !opened.isFile()) throw new EditingError('SOURCE_UNAUTHORIZED')
      assertEditingBytes(opened.size)
      const buffer = Buffer.alloc(opened.size + 1)
      let length = 0
      while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count }
      hooks.afterRead?.()
      const after = fstatSync(fd), bytes = buffer.subarray(0, length)
      pathFor(root)
      const current = stat(path)
      if (length !== opened.size || !same(opened, current) || [after, current!].some(v => v.size !== opened.size || v.mtimeMs !== opened.mtimeMs || v.ctimeMs !== opened.ctimeMs)) throw new EditingError('SOURCE_UNAUTHORIZED', '读取期间恢复草稿已变化')
      if (!isUtf8(bytes)) throw new EditingError('CORRUPT_DATA', '恢复草稿不是有效UTF-8')
      const document = parseEditingDocument(JSON.parse(bytes.toString('utf8')))
      return { document, signature: JSON.stringify([opened.dev, opened.ino, opened.size, opened.mtimeMs, opened.ctimeMs, createHash('sha256').update(bytes).digest('hex')]) }
    } catch (error) {
      if (error instanceof EditingError) throw error
      throw new EditingError('CORRUPT_DATA', '恢复草稿无法读取，原文件保留')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  return {
    read(root: string) { return load(root).document },
    commit(root: string, expected: number, input: EditingDocument, beforePublish: () => void): EditingDocument {
      if (!Number.isSafeInteger(expected) || expected < 0) throw new EditingError('BAD_REQUEST')
      const previous = load(root)
      if (previous.document.revision !== expected) throw new EditingError('CONFLICT', '恢复草稿已有更新，输入保留')
      const next = parseEditingDocument(input)
      if (next.revision !== expected + 1) throw new EditingError('BAD_REQUEST', '修订必须递增')
      const bytes = Buffer.from(JSON.stringify(next), 'utf8'), path = pathFor(root, true), folder = dirname(path), parent = lstatSync(folder), temp = `${path}.${randomUUID()}.partial`
      let fd: number | undefined, owned: ReturnType<typeof fstatSync> | undefined, published = false
      try {
        fd = openSync(temp, 'wx', 0o600); owned = fstatSync(fd)
        hooks.write?.(); writeFileSync(fd, bytes)
        hooks.sync?.(); fsyncSync(fd)
        hooks.close?.(); closeSync(fd); fd = undefined
        beforePublish()
        if (load(root).signature !== previous.signature) throw new EditingError('CONFLICT', '保存期间恢复草稿已变化')
        hooks.rename?.(); pathFor(root)
        if (!same(stat(folder), parent) || !same(stat(temp), owned)) throw new EditingError('SOURCE_UNAUTHORIZED', '恢复草稿暂存目录或文件已变化')
        renameSync(temp, path); published = true
        return next
      } catch (error) {
        if (error instanceof EditingError) throw error
        throw new EditingError('WRITE_FAILED', '暂存失败，原内容已保留，请检查磁盘')
      } finally {
        let failed = false
        if (fd !== undefined) { try { closeSync(fd) } catch { failed = true } }
        if (!published && owned) {
          try { const entry = stat(temp); if (entry && same(entry, owned) && same(stat(folder), parent)) unlinkSync(temp); else if (entry) failed = true } catch { failed = true }
        }
        if (failed) throw new EditingError('WRITE_FAILED', '无法安全清理本次临时文件，原资料保留')
      }
    }
  }
}
