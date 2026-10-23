import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, renameSync, statSync, utimesSync, symlinkSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

const probe = vi.hoisted(() => ({
  afterArchive: undefined as ((file: string) => void) | undefined,
  afterRead: undefined as ((file: string) => void) | undefined,
  readFailure: '',
  syncFailure: false,
  closeFailure: false,
  syncFd: -1,
  linkFailure: false
}))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    createWriteStream: ((...args: Parameters<typeof fs.createWriteStream>) => {
      const stream = fs.createWriteStream(...args)
      if (String(args[0]).endsWith('.zip.partial')) {
        stream.once('finish', () => probe.afterArchive?.(String(args[0])))
      }
      return stream
    }) as typeof fs.createWriteStream,
    createReadStream: ((...args: Parameters<typeof fs.createReadStream>) => {
      if (String(args[0]) === probe.readFailure) throw Object.assign(new Error('synthetic unreadable'), { code: 'EACCES' })
      const stream = fs.createReadStream(...args)
      stream.once('end', () => probe.afterRead?.(String(args[0])))
      return stream
    }) as typeof fs.createReadStream,
    fsyncSync: ((fd: number) => {
      probe.syncFd = fd
      if (probe.syncFailure) throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' })
      return fs.fsyncSync(fd)
    }) as typeof fs.fsyncSync,
    closeSync: ((fd: number) => {
      fs.closeSync(fd)
      if (probe.closeFailure && fd === probe.syncFd) throw new Error('synthetic close failure')
    }) as typeof fs.closeSync,
    linkSync: ((from: Parameters<typeof fs.linkSync>[0], to: Parameters<typeof fs.linkSync>[1]) => {
      if (probe.linkFailure) throw Object.assign(new Error('synthetic unsupported publication'), { code: 'ENOTSUP' })
      return fs.linkSync(from, to)
    }) as typeof fs.linkSync
  }
})

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-backup-consistency-'))
  roots.push(root)
  const source = join(root, '科研空间😀'), staging = join(root, 'staging'), destination = join(root, 'backup.zip')
  mkdirSync(source)
  const file = join(source, '资料.txt')
  writeFileSync(file, 'BEFORE')
  return { root, source, staging, destination, file,
    request: { root: source, stagingDir: staging, destination, assetsDb: null } }
}
const subject = () => import('../../../electron/workspaceBackup/packer')
const assertNoPublish = (f: ReturnType<typeof fixture>) => {
  expect(existsSync(f.destination)).toBe(false)
  expect(existsSync(f.staging) ? readdirSync(f.staging) : []).toEqual([])
}
afterEach(() => {
  probe.afterArchive = undefined
  probe.afterRead = undefined
  probe.readFailure = ''
  probe.syncFailure = false
  probe.closeFailure = false
  probe.syncFd = -1
  probe.linkFailure = false
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('临时包关闭失败也不能授予成功发布', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  probe.closeFailure = true
  await expect(createBackup(f.request)).rejects.toThrow('synthetic close failure')
  assertNoPublish(f)
})

it('发布卷不支持原子不覆盖原语时失败，不降级写半包', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  probe.linkFailure = true
  await expect(createBackup(f.request)).rejects.toThrow('synthetic unsupported publication')
  assertNoPublish(f)
  expect(readFileSync(f.file, 'utf8')).toBe('BEFORE')
})

it('来源在惰性读流启动前消失，观察错误并等流关闭后清理', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  let reads = 0
  probe.afterRead = file => { if (file === f.file && ++reads === 2) rmSync(file) }
  await expect(createBackup(f.request)).rejects.toThrow()
  assertNoPublish(f)
})

it('输出祖先junction指向来源内，创建前拒绝且来源不被写入', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  const alias = join(f.root, 'alias')
  symlinkSync(f.source, alias, 'junction')
  await expect(createBackup({ ...f.request, stagingDir: join(alias, 'staging') }))
    .rejects.toMatchObject({ code: 'INVALID_DESTINATION' })
  expect(existsSync(join(f.source, 'staging'))).toBe(false)
  assertNoPublish(f)
})

it('快照之后新提交WAL必须被识别，不能用快照屏蔽来源变化', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  mkdirSync(join(f.source, '.mimir/assets'), { recursive: true })
  const db = new Database(join(f.source, '.mimir/assets/assets.db'))
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    db.exec('CREATE TABLE t(value TEXT); INSERT INTO t VALUES (\'before\')')
    probe.afterArchive = () => db.prepare('INSERT INTO t VALUES (?)').run('late')
    await expect(createBackup({ ...f.request, assetsDb: db, assetsDbRelPath: '.mimir/assets/assets.db' }))
      .rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    assertNoPublish(f)
  } finally { db.close() }
})

it('已正常关库的WAL数据库以只读句柄备份，不把SQLite延迟创建空旁文件误判来源变化', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  mkdirSync(join(f.source, '.mimir/assets'), { recursive: true })
  const path = join(f.source, '.mimir/assets/assets.db')
  const seed = new Database(path)
  seed.pragma('journal_mode = WAL')
  seed.exec('CREATE TABLE t(value TEXT); INSERT INTO t VALUES (\'committed\')')
  seed.close()
  const before = readFileSync(path)
  expect(existsSync(`${path}-wal`)).toBe(false)
  const db = new Database(path, { readonly: true })
  try {
    await expect(createBackup({ ...f.request, assetsDb: db, assetsDbRelPath: '.mimir/assets/assets.db' }))
      .resolves.toMatchObject({ destination: f.destination })
    expect(readFileSync(path)).toEqual(before)
  } finally { db.close() }
})

for (const mode of ['modify', 'add', 'remove', 'rename', 'replace'] as const) {
  it(`归档写完后来源${mode}，不能返回成功或发布正式包`, async () => {
    const { createBackup } = await subject()
    const f = fixture()
    probe.afterArchive = () => {
      if (mode === 'modify') writeFileSync(f.file, 'AFTER!')
      if (mode === 'add') writeFileSync(join(f.source, 'late.txt'), 'new file')
      if (mode === 'remove') rmSync(f.file)
      if (mode === 'rename') renameSync(f.file, join(f.source, 'renamed.txt'))
      if (mode === 'replace') {
        const before = statSync(f.file)
        const replacement = join(f.root, 'replacement')
        writeFileSync(replacement, 'BEFORE')
        utimesSync(replacement, before.atime, before.mtime)
        renameSync(replacement, f.file)
      }
    }
    await expect(createBackup(f.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    assertNoPublish(f)
  })
}

it('首次计算来源摘要期间内容变化，也须拒绝成功发布', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  probe.afterRead = file => {
    if (file !== f.file) return
    probe.afterRead = undefined
    writeFileSync(file, 'AFTER!')
  }
  await expect(createBackup(f.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  assertNoPublish(f)
})

it('最终遍历已枚举目录后新增文件，不能漏过复核', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  let packingFinished = false
  probe.afterArchive = () => { packingFinished = true }
  probe.afterRead = file => {
    if (file === f.file && packingFinished) writeFileSync(join(f.source, 'late.txt'), 'new during final scan')
  }
  await expect(createBackup(f.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  assertNoPublish(f)
})

it('最终遍历读后面的文件时，已读文件再被修改也不能发布', async () => {
  const { createBackup } = await subject()
  const f = fixture(), first = join(f.source, 'aa.txt'), last = join(f.source, 'zz.txt')
  writeFileSync(first, 'BEFORE')
  writeFileSync(last, 'last file')
  let packingFinished = false
  probe.afterArchive = () => { packingFinished = true }
  probe.afterRead = file => {
    if (file === last && packingFinished) writeFileSync(first, 'AFTER!')
  }
  await expect(createBackup(f.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  assertNoPublish(f)
})

it('打包中目标祖先junction改向来源，发布前拒绝并不写来源', async () => {
  const { createBackup } = await subject()
  const f = fixture(), alias = join(f.root, 'alias'), outside = join(f.root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, alias, 'junction')
  probe.afterArchive = () => {
    if (process.platform === 'win32') rmdirSync(alias)
    else unlinkSync(alias)
    symlinkSync(f.source, alias, 'junction')
  }
  await expect(createBackup({ ...f.request, destination: join(alias, 'backup.zip') }))
    .rejects.toMatchObject({ code: 'INVALID_DESTINATION' })
  expect(existsSync(join(f.source, 'backup.zip'))).toBe(false)
  expect(existsSync(join(outside, 'backup.zip'))).toBe(false)
})

it('复核来源无法读取时不以包内摘要正确替代成功', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  probe.afterArchive = () => { probe.readFailure = f.file }
  await expect(createBackup(f.request)).rejects.toThrow()
  assertNoPublish(f)
})

it('临时ZIP损坏须在正式可见前独立验包拒绝', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  probe.afterArchive = partial => {
    expect(existsSync(f.destination)).toBe(false)
    writeFileSync(partial, 'synthetic broken zip')
  }
  await expect(createBackup(f.request)).rejects.toThrow()
  assertNoPublish(f)
})

it('独立验包后复核来源期间临时包被改动，也不得发布旧校验结果', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  let partial = ''
  probe.afterArchive = path => { partial = path }
  probe.afterRead = path => {
    if (path === f.file && partial) writeFileSync(partial, 'changed after verify')
  }
  await expect(createBackup(f.request)).rejects.toThrow('临时备份')
  assertNoPublish(f)
})

it('落盘同步失败不发布且清理本次暂存', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  probe.syncFailure = true
  await expect(createBackup(f.request)).rejects.toThrow('synthetic sync failure')
  assertNoPublish(f)
})

it('目标在打包过程中出现也绝不覆盖既有内容', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  probe.afterArchive = () => writeFileSync(f.destination, 'USER-OWNED')
  await expect(createBackup(f.request)).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
  expect(readFileSync(f.destination, 'utf8')).toBe('USER-OWNED')
  expect(readdirSync(f.staging)).toEqual([])
})

for (const kind of ['staging', 'destination'] as const) {
  it(`拒绝${kind}位于来源内，在创建任何输出前失败`, async () => {
    const { createBackup } = await subject()
    const f = fixture()
    const inside = join(f.source, 'output')
    await expect(createBackup({ ...f.request,
      ...(kind === 'staging' ? { stagingDir: inside } : { destination: inside })
    })).rejects.toMatchObject({ code: 'INVALID_DESTINATION' })
    expect(existsSync(inside)).toBe(false)
    assertNoPublish(f)
  })
}

it('稳定来源成功，独立验包可读，原资料不被备份写入', async () => {
  const { createBackup } = await subject()
  const { verifyBackup } = await import('../../../electron/workspaceBackup/verify')
  const f = fixture()
  const before = readFileSync(f.file)
  const result = await createBackup(f.request)
  expect(result.destination).toBe(f.destination)
  expect(result.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
  await expect(verifyBackup(f.destination)).resolves.toMatchObject({ entries: result.entries })
  expect(readFileSync(f.file)).toEqual(before)
  expect(readdirSync(f.staging)).toEqual([])
})

it('运行锁、SHM和未提交staging变化不冒充稳定业务资料变化', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  mkdirSync(join(f.source, '.mimir/assets/staging'), { recursive: true })
  probe.afterArchive = () => {
    writeFileSync(join(f.source, '.mimir/assets/assets.db-shm'), 'coordination')
    writeFileSync(join(f.source, '.mimir/workspace.writer-lock'), 'runtime')
    writeFileSync(join(f.source, '.mimir/assets/staging/partial'), 'pending')
  }
  await expect(createBackup(f.request)).resolves.toMatchObject({ destination: f.destination })
})

it('已排除的超限文件大小变化仍需报告来源不稳定', async () => {
  const { createBackup } = await subject()
  const f = fixture()
  const large = join(f.source, 'excluded.bin')
  writeFileSync(large, '0123456789')
  probe.afterArchive = () => writeFileSync(large, '0123456789x')
  await expect(createBackup({ ...f.request,
    limits: { maxEntries: 100, maxManifestBytes: 1_048_576, maxTotalBytes: 1_048_576, maxFileBytes: 6 }
  })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  assertNoPublish(f)
})
