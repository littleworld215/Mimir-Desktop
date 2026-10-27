import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RestoreJournal } from '../../../electron/workspaceBackup/restoreJournal'
import { publishInitialJournal } from '../../../electron/workspaceBackup/journalPublication'
import { assertRestoreDirectory } from '../../../electron/workspaceBackup/restoreFingerprint'

const probe = vi.hoisted(() => ({
  root: '', denyLink: false, linkCalls: 0, renameCalls: 0, failures: 0, code: 'EPERM',
  paths: new Map<number, string>(), closes: new Map<number, number>(),
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  afterRename: undefined as ((from: string, to: string) => void) | undefined,
  afterClose: undefined as ((file: string, fd: number) => void) | undefined,
  beforeFstat: undefined as ((file: string) => void) | undefined,
  beforeUnlink: undefined as ((file: string) => void) | undefined
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, fstatSync: (fd: number, options?: { bigint?: boolean }) => {
    const file = probe.paths.get(fd)
    if (file) probe.beforeFstat?.(file)
    return fs.fstatSync(fd, options)
  }, openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...args), file = String(args[0])
    if (probe.root && file.startsWith(probe.root)) probe.paths.set(fd, file)
    return fd
  }, closeSync: (fd: number) => {
    const file = probe.paths.get(fd)
    probe.paths.delete(fd)
    if (file) probe.closes.set(fd, (probe.closes.get(fd) ?? 0) + 1)
    fs.closeSync(fd)
    if (file) probe.afterClose?.(file, fd)
  }, renameSync: (from: string, to: string) => {
    if (probe.root && from.startsWith(probe.root)) {
      probe.renameCalls++
      probe.beforeRename?.(from, to)
      if (probe.failures > 0) {
        probe.failures--
        throw Object.assign(Error('synthetic publication rejection'), { code: probe.code })
      }
      fs.renameSync(from, to)
      probe.afterRename?.(from, to)
    } else fs.renameSync(from, to)
  }, unlinkSync: (file: string) => {
    if (probe.root && file.startsWith(probe.root)) probe.beforeUnlink?.(file)
    fs.unlinkSync(file)
  }, linkSync: (from: string, to: string) => {
    if (probe.root && from.startsWith(probe.root)) {
      probe.linkCalls++
      if (probe.denyLink) throw Object.assign(Error('synthetic initial hard-link rejection'), { code: 'EPERM' })
    }
    return fs.linkSync(from, to)
  } }
})
const roots: Array<{ path: string; real: string }> = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-journal-publication-'))
  roots.push({ path: root, real: realpathSync(root) })
  writeFileSync(join(root, 'test-owner'), 'journal-publication-test')
  probe.root = root
  return { root, journal: new RestoreJournal(root), target: join(root, '合成恢复空间') }
}
afterEach(() => {
  probe.root = ''; probe.linkCalls = 0; probe.denyLink = false
  probe.renameCalls = 0; probe.failures = 0; probe.code = 'EPERM'
  probe.paths.clear(); probe.closes.clear()
  probe.beforeRename = undefined; probe.afterRename = undefined; probe.afterClose = undefined; probe.beforeUnlink = undefined
  probe.beforeFstat = undefined
  for (const item of roots.splice(0)) {
    expect(realpathSync(item.path)).toBe(item.real)
    expect(readFileSync(join(item.path, 'test-owner'), 'utf8')).toBe('journal-publication-test')
    rmSync(item.path, { recursive: true })
  }
})

function publication(bytes = Buffer.from('{"version":1,"text":"合成完整记录"}')) {
  const f = fixture(), directory = join(f.root, '.mimir/restore-operations')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'synthetic.json'), temp = join(directory, '.tmp-owned')
  const cleanupFailed = vi.fn()
  const input = { file, temp, bytes, cleanupFailed, assertDirectory: () => { assertRestoreDirectory(directory) } }
  return { ...f, directory, file, temp, bytes, cleanupFailed, run: () => publishInitialJournal(input) }
}
const denied = () => Object.assign(Error('synthetic transition failure'), { code: 'EPERM' })

it.each(['', '{"version":1}', 'broken', '{"version":99}'])('已有目标原字节保留，不覆盖 %j', bytes => {
  const f = publication()
  writeFileSync(f.file, bytes)
  expect(f.run).toThrow()
  expect(readFileSync(f.file, 'utf8')).toBe(bytes)
  expect(existsSync(f.temp)).toBe(false)
  expect(f.cleanupFailed).not.toHaveBeenCalled()
})
it.each(['EPERM', 'EACCES', 'EBUSY'])('瞬时%s最多四次，完整文件单链接发布', code => {
  const f = publication(); probe.failures = process.platform === 'win32' ? 3 : 0; probe.code = code
  f.run()
  expect(probe.renameCalls).toBe(process.platform === 'win32' ? 4 : 1)
  expect(readFileSync(f.file)).toEqual(f.bytes)
  expect(lstatSync(f.file).nlink).toBe(1)
  expect(existsSync(f.temp)).toBe(false)
  expect(f.cleanupFailed).not.toHaveBeenCalled()
})
it.each([['EPERM', process.platform === 'win32' ? 4 : 1], ['ENOSPC', 1]] as const)('持续%s退出且只清理仍属本任务的两份文件', (code, attempts) => {
  const f = publication(); probe.failures = 100; probe.code = code
  expect(f.run).toThrow()
  expect(probe.renameCalls).toBe(attempts)
  expect(existsSync(f.file)).toBe(false)
  expect(existsSync(f.temp)).toBe(false)
  expect(f.cleanupFailed).not.toHaveBeenCalled()
})
it('外来同字节空占位保留，不能仅凭空内容认领', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication()
  probe.beforeRename = (_from, to) => { fs.renameSync(to, to + '.old'); fs.writeFileSync(to, ''); throw denied() }
  expect(f.run).toThrow()
  expect(readFileSync(f.file).length).toBe(0)
  expect(existsSync(f.file + '.old')).toBe(true)
  expect(probe.renameCalls).toBe(1)
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it('占位被写入后保留外来字节', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication()
  probe.beforeRename = (_from, to) => { fs.writeFileSync(to, '外来资料'); throw denied() }
  expect(f.run).toThrow()
  expect(readFileSync(f.file, 'utf8')).toBe('外来资料')
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it.each(['identity', 'bytes', 'same-bytes-stamp'])('临时文件变化%s不误删不发布', async mode => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication()
  probe.beforeRename = from => {
    if (mode === 'identity') { fs.renameSync(from, from + '.old'); fs.writeFileSync(from, f.bytes) }
    else if (mode === 'bytes') fs.writeFileSync(from, '外来临时资料')
    else fs.utimesSync(from, new Date(1000), new Date(1000))
    throw denied()
  }
  expect(f.run).toThrow()
  expect(existsSync(f.temp)).toBe(true)
  expect(existsSync(f.file)).toBe(false)
  expect(probe.renameCalls).toBe(1)
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it('占位变为硬链接后保留两处现场', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication()
  probe.beforeRename = (_from, to) => { fs.linkSync(to, to + '.alias'); throw denied() }
  expect(f.run).toThrow()
  expect(lstatSync(f.file).nlink).toBe(2)
  expect(existsSync(f.file + '.alias')).toBe(true)
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it('目录实体变化时不追随同名新目录清理', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication()
  const moved = f.directory + '-preserved'
  probe.beforeRename = () => { fs.renameSync(f.directory, moved); fs.mkdirSync(f.directory); throw denied() }
  expect(f.run).toThrow()
  expect(readFileSync(join(moved, '.tmp-owned'))).toEqual(f.bytes)
  expect(readFileSync(join(moved, 'synthetic.json')).length).toBe(0)
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it('叶目录不变但父目录实体被替换时拒绝发布并保留现场', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication()
  const control = join(f.root, '.mimir'), moved = join(f.root, 'old-control')
  probe.beforeRename = () => {
    probe.beforeRename = undefined
    fs.renameSync(control, moved); fs.mkdirSync(control)
    fs.renameSync(join(moved, 'restore-operations'), f.directory)
    throw denied()
  }
  expect(f.run).toThrow()
  expect(readFileSync(f.temp)).toEqual(f.bytes)
  expect(readFileSync(f.file).length).toBe(0)
  expect(probe.renameCalls).toBe(1)
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it('整个HOME移走造成目录ENOENT时明确报告收尾失败', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication(), moved = f.root + '-preserved'
  expect(existsSync(moved)).toBe(false)
  probe.beforeRename = () => { probe.beforeRename = undefined; fs.renameSync(f.root, moved); throw denied() }
  try {
    expect(f.run).toThrow()
    expect(readFileSync(join(moved, '.mimir/restore-operations/.tmp-owned'))).toEqual(f.bytes)
    expect(readFileSync(join(moved, '.mimir/restore-operations/synthetic.json')).length).toBe(0)
    expect(f.cleanupFailed).toHaveBeenCalled()
  } finally {
    if (existsSync(moved)) {
      expect(readFileSync(join(moved, 'test-owner'), 'utf8')).toBe('journal-publication-test')
      expect(existsSync(f.root)).toBe(false)
      fs.renameSync(moved, f.root)
    }
  }
})
it('非Windows旧首次发布分支仍使用单链接发布，平台模拟不代表对应系统实测', () => {
  const f = fixture(), platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const record = f.journal.create(f.target, '合成旧路径')
    expect(f.journal.read(record.id)).toEqual(record)
    expect(probe.linkCalls).toBe(1)
    expect(lstatSync(join(f.journal.directory, `${record.id}.json`)).nlink).toBe(1)
  } finally { Object.defineProperty(process, 'platform', platform) }
})
it.each(['temp', 'slot'])('%s关闭报错不再关闭后来复用的描述符', async role => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs'), f = publication()
  let foreign: number | undefined, closing: number | undefined
  probe.afterClose = (file, fd) => {
    if (file !== (role === 'temp' ? f.temp : f.file)) return
    closing = fd
    foreign = fs.openSync(join(f.root, 'foreign-fd'), 'wx')
    throw Error('synthetic close error after native close')
  }
  try {
    expect(f.run).toThrow()
    expect(foreign).toBeDefined()
    expect(foreign).toBe(closing)
    expect(probe.closes.get(closing!)).toBe(role === 'temp' ? 1 : 2)
    fs.writeSync(foreign!, '仍由外来所有者管理')
    expect(f.cleanupFailed).toHaveBeenCalled()
  } finally { if (foreign !== undefined) fs.closeSync(foreign) }
})
it('创建身份读取失败时保留未能认领的文件并报告收尾失败', () => {
  const f = publication()
  probe.beforeFstat = file => { if (file === f.temp) throw Object.assign(Error('synthetic fstat failure'), { code: 'EIO' }) }
  expect(f.run).toThrow()
  expect(existsSync(f.temp)).toBe(true)
  expect(existsSync(f.file)).toBe(false)
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it('实际替换已完成但返回处报错时保留完整记录', () => {
  const f = publication()
  probe.afterRename = () => { throw Object.assign(Error('synthetic receipt error'), { code: 'EIO' }) }
  expect(f.run).toThrow()
  expect(readFileSync(f.file)).toEqual(f.bytes)
  expect(lstatSync(f.file).nlink).toBe(1)
  expect(existsSync(f.temp)).toBe(false)
})
it('清理失败明确标记并保留已验证临时文件', () => {
  const f = publication(); probe.failures = 100
  probe.beforeUnlink = file => { if (file === f.temp) throw denied() }
  expect(f.run).toThrow()
  expect(readFileSync(f.temp)).toEqual(f.bytes)
  expect(existsSync(f.file)).toBe(false)
  expect(f.cleanupFailed).toHaveBeenCalled()
})
it('65536字节Unicode完整保留，超一字节在创建文件前拒绝', () => {
  const capacity = 65536 - Buffer.byteLength(JSON.stringify({ text: '' }))
  const bytes = Buffer.from(JSON.stringify({ text: '文'.repeat(Math.floor(capacity / 3)) + 'x'.repeat(capacity % 3) }))
  expect(bytes.length).toBe(65536)
  const f = publication(bytes); f.run()
  expect(readFileSync(f.file)).toEqual(bytes)
  const over = publication(Buffer.alloc(65537))
  expect(over.run).toThrow()
  expect(existsSync(over.file)).toBe(false)
  expect(existsSync(over.temp)).toBe(false)
})

it('Windows首次发布不依赖硬链接，其他平台保留原路径', () => {
  const f = fixture()
  probe.denyLink = process.platform === 'win32'
  const record = f.journal.create(f.target, '合成空间')
  expect(record).toMatchObject({ version: 1, revision: 0, phase: 'prepared' })
  expect(f.journal.read(record.id)).toEqual(record)
  expect(probe.linkCalls).toBe(process.platform === 'win32' ? 0 : 1)
})
