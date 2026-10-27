import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { RestoreError } from './restoreContracts'

export interface InitialJournalPublication {
  file: string
  temp: string
  bytes: Buffer
  assertDirectory: () => void
  cleanupFailed: () => void
}
type Stat = BigIntStats
const changed = () => new RestoreError('RECHECK_FAILED', '恢复操作记录发布现场发生变化，已保留资料。')
const identity = (s: Stat) => `${s.dev}:${s.ino}:${s.birthtimeNs}`
const stamp = (s: Stat) => `${identity(s)}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
function ordinary(s: Stat): void {
  if (!s.isFile() || s.isSymbolicLink() || s.ino === 0n || s.nlink !== 1n || s.size > 65536n) throw changed()
}
function observe(path: string) {
  const before = lstatSync(path, { bigint: true })
  ordinary(before)
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true })
  ordinary(after)
  if (stamp(before) !== stamp(after)) throw changed()
  return { bytes, identity: identity(after), stamp: stamp(after) }
}

/** Windows首次发布独占空占位；所有清理均受创建身份及原字节约束。 */
export function publishInitialJournal(input: InitialJournalPublication): void {
  const expected = Buffer.from(input.bytes)
  if (expected.length === 0 || expected.length > 65536 || resolve(input.temp) === resolve(input.file)
    || dirname(resolve(input.temp)) !== dirname(resolve(input.file))) throw changed()
  input.assertDirectory()
  const parents: Array<{ path: string; identity: string }> = []
  for (let cursor = dirname(resolve(input.file)); ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) throw changed()
    parents.push({ path: cursor, identity: identity(stat) })
    if (dirname(cursor) === cursor) break
  }
  const guard = () => {
    input.assertDirectory()
    for (const parent of parents) {
      const current = lstatSync(parent.path, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== parent.identity) throw changed()
    }
  }
  let fd: number | undefined, tempOwner: string | undefined, slotOwner: string | undefined, published = false
  let tempStamp: string | undefined, slotStamp: string | undefined
  let tempCreated = false, slotCreated = false
  const closeOwned = () => {
    if (fd === undefined) return
    const closing = fd
    // close报错时所有权不明，不能重试同编号并误关后来复用的描述符。
    fd = undefined
    try { closeSync(closing) } catch (error) { input.cleanupFailed(); throw error }
  }
  const cleanup = (path: string, owner: string | undefined, bytes: Buffer, allowPublished = false) => {
    if (!owner) return
    // 父链缺失不是“该文件已清理”；未确认原目录前不能忽略ENOENT。
    try { guard() } catch { input.cleanupFailed(); return }
    try {
      const current = observe(path)
      // rename已执行但返回处报错时，完整记录不是可删除的空占位。
      if (allowPublished && current.identity === tempOwner && current.bytes.equals(expected)) return
      if (current.identity !== owner || !current.bytes.equals(bytes)) throw changed()
      const expectedStamp = path === input.temp ? tempStamp : slotStamp
      if (expectedStamp !== undefined && current.stamp !== expectedStamp) throw changed()
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') input.cleanupFailed()
    }
  }
  try {
    guard()
    fd = openSync(input.temp, 'wx', 0o600)
    tempCreated = true
    const tempStat = fstatSync(fd, { bigint: true })
    ordinary(tempStat); tempOwner = identity(tempStat)
    writeFileSync(fd, expected); fsyncSync(fd); closeOwned()
    const prepared = observe(input.temp)
    if (prepared.identity !== tempOwner || !prepared.bytes.equals(expected)) throw changed()
    tempStamp = prepared.stamp
    guard()
    fd = openSync(input.file, 'wx', 0o600)
    slotCreated = true
    const slotStat = fstatSync(fd, { bigint: true })
    ordinary(slotStat); slotOwner = identity(slotStat)
    fsyncSync(fd); closeOwned()
    const baseline = observe(input.file)
    if (baseline.identity !== slotOwner || baseline.bytes.length !== 0) throw changed()
    slotStamp = baseline.stamp
    for (let attempt = 0; ; attempt++) {
      guard()
      const current = observe(input.file), pending = observe(input.temp)
      if (current.stamp !== baseline.stamp || current.bytes.length !== 0
        || pending.stamp !== prepared.stamp || !pending.bytes.equals(expected)) throw changed()
      try {
        renameSync(input.temp, input.file)
        const completed = observe(input.file)
        if (completed.identity !== tempOwner || !completed.bytes.equals(expected)) throw changed()
        published = true
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 3) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt)
      }
    }
  } finally {
    try { closeOwned() } finally {
      if (!published) {
        if ((tempCreated && !tempOwner) || (slotCreated && !slotOwner)) input.cleanupFailed()
        cleanup(input.temp, tempOwner, expected)
        cleanup(input.file, slotOwner, Buffer.alloc(0), true)
      }
    }
  }
}
