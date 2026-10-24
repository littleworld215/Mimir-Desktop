import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ASSETS_DDL, ASSETS_V1_DDL, ASSETS_V2_DDL, ASSETS_V3_DDL } from '../../../electron/assets/schema'
import { checkRestoredAssetsIntegrity } from '../../../electron/workspaceBackup/assetsIntegrity'
import { createMaintenanceRestoreSteps } from '../../../electron/workspaceBackup/restoreMain'
import { scanSpaces } from '../../../electron/workspaceBackup/doctorSpaceScan'
import { buildDoctorReport } from '../../../electron/workspaceBackup/doctorReport'
import { buildDoctorHandler } from '../../../electron/workspaceBackup/maintenanceDoctorHandler'
import * as migrations from '../../../electron/assets/migrations'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { createRequire } = await import('node:module')
  const native = createRequire(import.meta.url)('node:fs') as typeof actual
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => native.openSync(...args),
    closeSync: (...args: Parameters<typeof actual.closeSync>) => native.closeSync(...args),
    readSync: (...args: unknown[]) => Reflect.apply(native.readSync, native, args)
  }
})
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const clock = '2026-10-24T00:00:00.000Z'
function fixture(version = 4, filePath: string | null = 'files/1/历史😀.txt', changeDdl = (sql: string) => sql) {
  const root = mkdtempSync(join(tmpdir(), 'mimir-g03-'))
  roots.push(root)
  const assets = join(root, '.mimir/assets')
  mkdirSync(assets, { recursive: true })
  const dbPath = join(assets, 'assets.db')
  const db = new Database(dbPath)
  if (version !== 0) {
    for (const ddl of version === 1 ? ASSETS_V1_DDL : version === 2 ? ASSETS_V2_DDL : version === 3 ? ASSETS_V3_DDL : ASSETS_DDL) db.exec(changeDdl(ddl))
    db.prepare('INSERT INTO asset_category(code,name,created_at) VALUES(?,?,?)').run('inbox', '未分类', clock)
    db.prepare('INSERT INTO asset(id,code,name,category,storage_type,archived_at,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)')
      .run('history', '归档资料', 'inbox', 'file', clock, clock, clock)
    db.prepare('INSERT INTO asset_version(id,asset_id,version,content,file_path,created_at) VALUES(1,1,1,?,?,?)').run('历史', filePath, clock)
    db.prepare('INSERT INTO asset_version(id,asset_id,version,content,file_path,created_at) VALUES(2,1,2,?,?,?)').run('当前', 'files/1/当前.txt', clock)
    db.prepare('INSERT INTO asset_version(id,asset_id,version,content,file_path,created_at) VALUES(3,1,3,?,?,?)').run('回滚复用', 'files/1/当前.txt', clock)
    db.exec('UPDATE asset SET current_version_id=3 WHERE id=1')
  }
  db.pragma(`user_version=${version}`)
  db.close()
  mkdirSync(join(assets, 'files/1'), { recursive: true })
  writeFileSync(join(assets, 'files/1/历史😀.txt'), '历史\n\n')
  writeFileSync(join(assets, 'files/1/当前.txt'), '当前')
  return { root, dbPath, assets }
}
function recheck(root: string) {
  return createMaintenanceRestoreSteps(false, () => ({ release() {} })).recheck({} as never, root)
}

it.each([0, 1, 2, 3])('恢复已知版本%s仅升级暂存副本，快照保留旧结构和历史资料', async version => {
  const f = fixture(version)
  // 源副本放在本任务根内，避免清理跨出临时边界。
  const sourcePath = join(f.root, 'source-original.db')
  copyFileSync(f.dbPath, sourcePath)
  const before = readFileSync(f.dbPath)
  await recheck(f.root)
  const db = new Database(f.dbPath, { readonly: true })
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    if (version !== 0) expect(db.prepare('SELECT content,file_path FROM asset_version ORDER BY id').all()).toHaveLength(3)
  } finally { db.close() }
  const backups = readdirSync(join(f.assets, 'backups')).filter(name => name.endsWith('.db'))
  expect(backups).toHaveLength(1)
  // SQLite backup保证一致内容，页头计数可能不同，不错误要求物理字节相同。
  const snapshot = new Database(join(f.assets, 'backups', backups[0]), { readonly: true })
  try {
    expect(snapshot.pragma('user_version', { simple: true })).toBe(version)
    if (version !== 0) expect(snapshot.prepare('SELECT content,file_path FROM asset_version ORDER BY id').all())
      .toEqual([{ content: '历史', file_path: 'files/1/历史😀.txt' }, { content: '当前', file_path: 'files/1/当前.txt' }, { content: '回滚复用', file_path: 'files/1/当前.txt' }])
  } finally { snapshot.close() }
  expect(readFileSync(sourcePath)).toEqual(before)
})

it('当前库不迁移、不额外生成迁移快照；允许NULL及回滚复用', async () => {
  const f = fixture(4, null)
  const before = readFileSync(f.dbPath)
  await recheck(f.root)
  expect(readFileSync(f.dbPath)).toEqual(before)
  expect(existsSync(join(f.assets, 'backups'))).toBe(false)
})

it.each([5, 999, -1])('拒绝未来/非法版本%s，主库不变且不迁移', async version => {
  const f = fixture(version)
  const before = readFileSync(f.dbPath)
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'VERSION_UNSUPPORTED' })
  expect(readFileSync(f.dbPath)).toEqual(before)
  expect(existsSync(join(f.assets, 'backups'))).toBe(false)
})

it('只读检查发现旧库但不迁移', async () => {
  const f = fixture(1)
  const before = readFileSync(f.dbPath)
  await expect(checkRestoredAssetsIntegrity(f.dbPath)).resolves.toBeUndefined()
  expect(readFileSync(f.dbPath)).toEqual(before)
  expect(existsSync(join(f.assets, 'backups'))).toBe(false)
})

it('非当前且已归档的历史附件缺失仍阻断恢复', async () => {
  const f = fixture(1)
  rmSync(join(f.assets, 'files/1/历史😀.txt'))
  const before = readFileSync(f.dbPath)
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(readFileSync(f.dbPath)).toEqual(before)
  expect(existsSync(join(f.assets, 'backups'))).toBe(false)
})

it.each(['', '../outside.txt', 'files/1/../../outside.txt', '/files/1/a', 'C:/files/1/a', '\\\\server\\x',
  'files/2/当前.txt', 'files/01/当前.txt', 'files/1/当前.txt:secret', 'files/1/NUL.txt', 'files/1/尾点.', 'files/1'])
('拒绝非法或不属该资产的历史路径 %j', async filePath => {
  const f = fixture(4, filePath)
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it('兼容历史反斜杠路径及Unicode', async () => {
  const f = fixture(4, 'files\\1\\历史😀.txt')
  await expect(recheck(f.root)).resolves.toBeUndefined()
})

it.each([0, 1, 4])('版本%s的未知表/缺失触发器不能猜修', async version => {
  const f = fixture(version)
  const db = new Database(f.dbPath)
  db.exec('CREATE TABLE unknown_business(value TEXT)')
  db.close()
  const before = readFileSync(f.dbPath)
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(readFileSync(f.dbPath)).toEqual(before)
})

it('附件目录junction不能将已验证路径转向空间之外', async () => {
  const f = fixture(4)
  const external = join(f.root, 'external')
  mkdirSync(join(external, '1'), { recursive: true })
  writeFileSync(join(external, '1/历史😀.txt'), '外部历史')
  writeFileSync(join(external, '1/当前.txt'), '外部当前')
  rmSync(join(f.assets, 'files'), { recursive: true })
  symlinkSync(external, join(f.assets, 'files'), 'junction')
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it('迁移快照目录为普通文件时失败且不修改旧库', async () => {
  const f = fixture(1)
  writeFileSync(join(f.assets, 'backups'), '用户资料')
  const before = readFileSync(f.dbPath)
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(readFileSync(f.dbPath)).toEqual(before)
  expect(readFileSync(join(f.assets, 'backups'), 'utf8')).toBe('用户资料')
})

it('自检按真实资产域路径调用校验，不误查根目录同名文件', async () => {
  const f = fixture(4)
  const checked: string[] = []
  const result = await scanSpaces([{ id: 'synthetic', name: '合成空间', path: f.root }], async dbPath => {
    checked.push(dbPath)
    await checkRestoredAssetsIntegrity(dbPath)
  })
  expect(result.severity).toBe('ok')
  expect(checked).toEqual([f.dbPath])
})

it('原生绑定选项从维护自检handler透传，避免目录包借用开发缓存', async () => {
  const f = fixture()
  let captured: unknown
  const options = { isPackaged: true, resourcesPath: join(f.root, 'resources') }
  const handler = buildDoctorHandler({ homeDir: f.root, assetsIntegrityOptions: options,
    buildReport: async deps => { captured = deps.assetsIntegrityOptions; return buildDoctorReport({ ...deps, resolveSpaces: () => [] }) }
  })
  await handler.doctor()
  expect(captured).toEqual(options)
})

it('无资产模块空间自检不创建数据库也不误报资产库损坏', async () => {
  const f = fixture()
  rmSync(join(f.root, '.mimir'), { recursive: true })
  const report = await buildDoctorReport({ home: f.root, readRegistry: () => [], listArchives: async () => [], scanResiduals: () => [],
    resolveSpaces: () => [{ id: 'empty', name: '空空间', path: f.root }] })
  expect(report.checks.find(check => check.id === 'SPACE_INTEGRITY')?.severity).toBe('ok')
  expect(existsSync(join(f.root, '.mimir'))).toBe(false)
})

it('已登记的空间目录缺失不能被当作无资产模块而报通过', async () => {
  const f = fixture()
  const report = await buildDoctorReport({ home: f.root, readRegistry: () => [], listArchives: async () => [], scanResiduals: () => [],
    resolveSpaces: () => [{ id: 'lost', name: '缺失空间', path: join(f.root, 'missing') }] })
  expect(report.checks.find(check => check.id === 'SPACE_INTEGRITY')?.severity).toBe('warning')
})

it('资产目录为悬垂链接也不能按缺库跳过', async () => {
  const f = fixture()
  rmSync(f.assets, { recursive: true })
  const missing = join(f.root, 'missing')
  mkdirSync(missing)
  symlinkSync(missing, f.assets, 'junction')
  rmSync(missing, { recursive: true })
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it('迁移快照写入失败保持旧库且不运行DDL', async () => {
  const f = fixture(1)
  const before = readFileSync(f.dbPath)
  vi.spyOn(migrations, 'snapshotBeforeMigration').mockRejectedValueOnce(Error('synthetic disk full'))
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(readFileSync(f.dbPath)).toEqual(before)
})

it('迁移DDL失败回滚，旧资料不变且保留独立快照', async () => {
  const f = fixture(1)
  const before = readFileSync(f.dbPath)
  vi.spyOn(migrations, 'initializeSchema').mockImplementationOnce(() => { throw Error('synthetic migration failure') })
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(readFileSync(f.dbPath)).toEqual(before)
  expect(readdirSync(join(f.assets, 'backups')).filter(name => name.endsWith('.db'))).toHaveLength(1)
})

it('暂存DB仍是其它文件的硬链接时不允许迁移', async () => {
  const f = fixture(1)
  const source = join(f.root, 'original.db')
  linkSync(f.dbPath, source)
  const before = readFileSync(source)
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(readFileSync(source)).toEqual(before)
})

it('只读数据库关闭失败不能被当作校验成功', async () => {
  const f = fixture()
  const close = Database.prototype.close
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    close.call(this)
    if (this.name === f.dbPath) throw Error('synthetic close failure')
    return this
  })
  await expect(checkRestoredAssetsIntegrity(f.dbPath)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it.each(["'pending'", "'inline_text'"])('完整DDL比较不能忽略字符串字面量 %s 的大小写', async literal => {
  const f = fixture(4, null, sql => sql.replaceAll(literal, literal.toUpperCase()))
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it.each(['EIO', 'earlyEOF'])('附件能打开但实际读取%s仍必须失败并关闭句柄', async fault => {
  const f = fixture()
  const target = join(f.assets, 'files/1/历史😀.txt')
  const realOpen = fs.openSync, realClose = fs.closeSync, realRead = fs.readSync
  let handle: number | undefined
  let closed = false
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = realOpen(...args)
    if (args[0] === target) handle = fd
    return fd
  })
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    realClose(fd)
    if (fd === handle) closed = true
  })
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: unknown[]) => {
    if (fd === handle) {
      if (fault === 'earlyEOF') return 0
      throw Object.assign(Error('synthetic read EIO'), { code: 'EIO' })
    }
    return Reflect.apply(realRead, fs, [fd, ...args]) as number
  }) as typeof fs.readSync)
  await expect(recheck(f.root)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(handle).toBeDefined()
  expect(closed).toBe(true)
})

it('回滚复用同一附件只完整读取一次', async () => {
  const f = fixture()
  const target = join(f.assets, 'files/1/当前.txt')
  const realOpen = fs.openSync
  let reads = 0
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === target) reads++
    return realOpen(...args)
  })
  await checkRestoredAssetsIntegrity(f.dbPath)
  expect(reads).toBe(1)
})
