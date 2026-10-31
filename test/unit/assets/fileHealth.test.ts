import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import { promises as io } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { createAsset } from '../../../electron/assets/assetService'
import { inspectFileHealthBatch } from '../../../electron/assets/fileHealth'
import type { AssetsContext } from '../../../electron/assets/types'

let root: string, manager: AssetsStoreManager, ctx: AssetsContext, db: Database.Database, epoch: string
beforeEach(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'assets-health-')); epoch = 'A#1'
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => (db = new Database(p, o)))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => {
  await manager.close()
  expect(root.startsWith(join(tmpdir(), 'assets-health-'))).toBe(true)
  fs.rmSync(root, { recursive: true, force: true })
})
function asset() { return createAsset(ctx, { name: 'Health文件', category: 'inbox', storageType: 'file' }) }
function version(id: number, path: string | null, number = 1) {
  return Number(db.prepare('INSERT INTO asset_version(asset_id,version,file_path,content,created_at) VALUES(?,?,?,?,?)').run(id, number, path, 'PRIVATE_BODY_NOT_FOR_REPORT', new Date().toISOString()).lastInsertRowid)
}
function ordinary(id: number, name = 'a.bin') {
  const rel = `files/${id}/${name}`
  fs.mkdirSync(join(ctx.layout.filesDir, String(id)), { recursive: true }); fs.writeFileSync(join(ctx.layout.root, rel), 'unchanged-content')
  return rel
}
it('归档和历史均检查；SELECT-only事务可运行，结果不含正文、路径或完整性承诺', async () => {
  const a = asset(), path = ordinary(a.id)
  version(a.id, path); version(a.id, path, 2)
  db.prepare('UPDATE asset SET archived_at=? WHERE id=?').run(new Date().toISOString(), a.id)
  createAsset(ctx, { name: '非文件', category: 'inbox', storageType: 'inline_text', content: 'secret' })
  db.pragma('query_only = ON')
  const result = await inspectFileHealthBatch(ctx, {})
  expect(result.items.map(x => x.status)).toEqual(['openable', 'openable'])
  expect(result.items.every(x => x.archived)).toBe(true)
  expect(result.nextCursor).toBeNull()
  expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY')
  expect(JSON.stringify(result)).not.toContain(root)
  expect(JSON.stringify(result)).not.toContain('a.bin')
  expect(result.digestBaseline).toBe('not-established')
  expect(fs.readFileSync(join(ctx.layout.root, path), 'utf8')).toBe('unchanged-content')
})
it.each([
  ['files/1/missing.bin', 'missing'], ['../outside', 'invalid_path'], ['C:/secret', 'invalid_path'],
  ['files/999/a.bin', 'wrong_owner'], ['files/1/a:stream', 'invalid_path'], ['files/1/CON', 'invalid_path'],
  ['files/1/dir', 'not_file'], [null, 'no_file']
])('异常路径 %s → %s，不返回原始路径', async (path, status) => {
  const a = asset(); fs.mkdirSync(join(ctx.layout.filesDir, String(a.id), 'dir'), { recursive: true })
  version(a.id, path)
  const result = await inspectFileHealthBatch(ctx, {})
  expect(result.items[0].status).toBe(status)
  expect(Object.keys(result.items[0])).not.toContain('path')
})
it('无历史版本的文件资产仍明确报告；空库不误报通过条数', async () => {
  expect((await inspectFileHealthBatch(ctx, {})).items).toEqual([])
  asset()
  expect((await inspectFileHealthBatch(ctx, {})).items[0]).toMatchObject({ versionId: null, version: null, status: 'no_file' })
})
it('每批至多50，固定上界不会把检查开始后新增历史版本混入', async () => {
  const a = asset(), path = ordinary(a.id)
  for (let n = 1; n <= 53; n++) version(a.id, path, n)
  const first = await inspectFileHealthBatch(ctx, {})
  expect(first.items).toHaveLength(50); expect(first.nextCursor).not.toBeNull()
  version(a.id, path, 54)
  const second = await inspectFileHealthBatch(ctx, { cursor: first.nextCursor! })
  expect(second.items.map(x => x.version)).toEqual([51, 52, 53]); expect(second.nextCursor).toBeNull()
})
it.each([{ rootPath: 'C:/secret' }, { cursor: {} }, { cursor: { assetId: -1 } }, { pageSize: 999 }])('不接受任意路径、错误游标或任意页长 %j', async request => {
  await expect(inspectFileHealthBatch(ctx, request)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})
it('真实junction越界在打开前拒绝，库外文件不被读取或打开', async () => {
  const a = asset(), outside = join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'secret'), 'secret')
  fs.symlinkSync(outside, join(ctx.layout.filesDir, String(a.id)), process.platform === 'win32' ? 'junction' : 'dir')
  version(a.id, `files/${a.id}/secret`)
  const open = vi.fn(io.open)
  expect((await inspectFileHealthBatch(ctx, {}, { ...io, open })).items[0].status).toBe('invalid_path')
  expect(open).not.toHaveBeenCalled()
})
it('打开被拒绝明确报告不可打开，不吞掉整批其他条目', async () => {
  const a = asset(), path = ordinary(a.id); version(a.id, path)
  const open = vi.fn().mockRejectedValue(Object.assign(new Error(root), { code: 'EACCES' }))
  expect((await inspectFileHealthBatch(ctx, {}, { ...io, open })).items[0].status).toBe('unreadable')
})
it('打开后空间切换必须关闭句柄并拒绝旧报告', async () => {
  const a = asset(), path = ordinary(a.id); version(a.id, path)
  let closed = false
  const open: typeof io.open = async (...args) => {
    const handle = await io.open(...args), original = handle.close.bind(handle)
    handle.close = async () => { closed = true; await original() }
    epoch = 'A#2'; return handle
  }
  await expect(inspectFileHealthBatch(ctx, {}, { ...io, open })).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
  expect(closed).toBe(true)
})
it('关闭失败停止检查，不能返回可打开结论', async () => {
  const a = asset(), path = ordinary(a.id); version(a.id, path)
  const open: typeof io.open = async (...args) => {
    const handle = await io.open(...args), original = handle.close.bind(handle)
    handle.close = async () => { await original(); throw Error('close fault') }; return handle
  }
  await expect(inspectFileHealthBatch(ctx, {}, { ...io, open })).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
})
it('真实文件在打开期间改变时报告变化，句柄不读任何内容且被关闭', async () => {
  const a = asset(), path = ordinary(a.id); version(a.id, path)
  const read = vi.fn().mockRejectedValue(Error('Content read forbidden'))
  let closed = false
  const open: typeof io.open = async (...args) => {
    const handle = await io.open(...args), close = handle.close.bind(handle)
    handle.read = read as typeof handle.read
    handle.readFile = read as typeof handle.readFile
    handle.close = async () => { closed = true; await close() }
    fs.appendFileSync(join(ctx.layout.root, path), 'changed during check')
    return handle
  }
  expect((await inspectFileHealthBatch(ctx, {}, { ...io, open })).items[0].status).toBe('changed')
  expect(read).not.toHaveBeenCalled(); expect(closed).toBe(true)
})

function signal() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it('每批最多四个文件同时检查，历史版本不缓存任何路径或句柄核验', async () => {
  const a = asset(), path = ordinary(a.id), gate = signal()
  for (let n = 1; n <= 53; n++) version(a.id, path, n)
  let active = 0, peak = 0, closed = 0, stats = 0
  const lstat = vi.fn(io.lstat)
  const open: typeof io.open = async (...args) => {
    const handle = await io.open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle)
    active++; peak = Math.max(peak, active)
    handle.stat = async () => { stats++; await gate.promise; return stat() }
    handle.close = async () => { try { await close() } finally { active--; closed++ } }
    return handle
  }
  const pending = inspectFileHealthBatch(ctx, {}, { lstat, open })
  try {
    await vi.waitFor(() => expect(active).toBe(4), { timeout: 1500 })
  } finally { gate.release(); await pending }
  const first = await pending
  expect(peak).toBe(4); expect(active).toBe(0); expect(closed).toBe(50); expect(stats).toBe(50)
  expect(lstat.mock.calls.filter(([file]) => file === join(ctx.layout.root, path))).toHaveLength(100)
  expect(first.items.map(item => item.version)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  expect(first.items.every(item => item.status === 'openable')).toBe(true)
  expect(first.nextCursor).toMatchObject({ versionId: first.items[49].versionId, upperVersionId: 53 })
})

it('较晚文件先结束时仍按资产与版本顺序返回全部状态', async () => {
  const a = asset(), first = ordinary(a.id, 'first.bin'), second = ordinary(a.id, 'second.bin')
  version(a.id, first, 1); version(a.id, second, 2); version(a.id, `files/${a.id}/missing.bin`, 3)
  version(a.id, null, 4); version(a.id, 'files/999/no-owner.bin', 5)
  const gate = signal(), laterClosed = signal(), completion: string[] = []
  const open: typeof io.open = async (...args) => {
    const handle = await io.open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle)
    const isFirst = args[0] === join(ctx.layout.root, first)
    handle.stat = async () => { if (isFirst) await gate.promise; return stat() }
    handle.close = async () => {
      await close(); completion.push(isFirst ? 'first' : 'second')
      if (!isFirst) laterClosed.release()
    }
    return handle
  }
  const pending = inspectFileHealthBatch(ctx, {}, { ...io, open })
  try {
    await vi.waitFor(() => expect(completion).toEqual(['second']), { timeout: 1500 })
    await laterClosed.promise
  } finally { gate.release(); await pending }
  const result = await pending
  expect(completion).toEqual(['second', 'first'])
  expect(result.items.map(item => [item.version, item.status])).toEqual([
    [1, 'openable'], [2, 'openable'], [3, 'missing'], [4, 'no_file'], [5, 'wrong_owner']
  ])
})

it.each(['close', 'space'] as const)('%s失败停止派新且必须等另外三条真实句柄关闭后才拒绝', async kind => {
  const a = asset(), path = ordinary(a.id)
  for (let n = 1; n <= 9; n++) version(a.id, path, n)
  const gates = Array.from({ length: 9 }, signal), closed: number[] = []
  let started = 0, settled = false
  const open: typeof io.open = async (...args) => {
    const handle = await io.open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle)
    const index = started++
    handle.stat = async () => { await gates[index].promise; return stat() }
    handle.close = async () => {
      await close(); closed.push(index)
      if (index === 0 && kind === 'close') throw Error('close fault')
    }
    return handle
  }
  const pending = inspectFileHealthBatch(ctx, {}, { ...io, open })
  const observed = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    .finally(() => { settled = true })
  try {
    await vi.waitFor(() => expect(started).toBe(4), { timeout: 1500 })
    if (kind === 'space') epoch = 'A#2'
    gates[0].release()
    await vi.waitFor(() => expect(closed).toEqual([0]))
    expect(settled).toBe(false); expect(started).toBe(4)
  } finally { gates.forEach(gate => gate.release()); await observed }
  const result = await observed
  expect(result.error).toMatchObject({ code: kind === 'close' ? 'FILE_UNAVAILABLE' : 'SPACE_CHANGED' })
  expect(result.value).toBeUndefined(); expect(started).toBe(4); expect(closed.sort()).toEqual([0, 1, 2, 3])
})

it.each(['space-first', 'close-first'] as const)('%s：空间切换等待全部检查，关闭失败不能被空间中止掩盖', async order => {
  const a = asset(), path = ordinary(a.id)
  for (let n = 1; n <= 9; n++) version(a.id, path, n)
  const gates = Array.from({ length: 9 }, signal), closed: number[] = []
  let started = 0, switched = false, switching: Promise<void> | undefined
  const open: typeof io.open = async (...args) => {
    const handle = await io.open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle)
    const index = started++
    handle.stat = async () => { await gates[index].promise; return stat() }
    handle.close = async () => { await close(); closed.push(index); if (index === 1) throw Error('close fault') }
    return handle
  }
  const pending = manager.run(manager.context(), current => inspectFileHealthBatch(current, {}, { ...io, open }))
  const observed = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  try {
    await vi.waitFor(() => expect(started).toBe(4), { timeout: 1500 })
    switching = manager.beforeSpaceSwitch().then(() => { switched = true })
    for (const index of order === 'space-first' ? [0, 1] : [1, 0]) {
      gates[index].release()
      await vi.waitFor(() => expect(closed).toContain(index))
      expect(switched).toBe(false); expect(db.open).toBe(true); expect(started).toBe(4)
    }
  } finally {
    gates.forEach(gate => gate.release())
    await observed; await switching
  }
  expect((await observed).error).toMatchObject({ code: 'FILE_UNAVAILABLE' })
  expect(closed.sort()).toEqual([0, 1, 2, 3]); expect(db.open).toBe(false)
})
