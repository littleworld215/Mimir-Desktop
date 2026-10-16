import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'mimir-manifest-')); roots.push(value); return value }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })
async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/manifest.ts')).catch(() => ({} as any))
  expect(mod.buildManifest).toBeTypeOf('function')
  return mod
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

it.each(['.mimir/workspace.writer-lock', '.mimir/assets/assets.db.writer-lock', '.MIMIR/WORKSPACE.WRITER-LOCK'])('运行锁 %s 不进归档，不误排普通资料', async lock => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  const controlDirectory = lock.startsWith('.MIMIR/') ? '.MIMIR' : '.mimir'
  mkdirSync(join(space, controlDirectory, 'assets'), { recursive: true })
  mkdirSync(join(space, 'notes'), { recursive: true })
  writeFileSync(join(space, lock), 'runtime lock')
  writeFileSync(join(space, controlDirectory, 'workspace.writer-lock.bak'), 'protected backup')
  writeFileSync(join(space, 'notes/workspace.writer-lock'), 'user data')
  const { entries } = await buildManifest(space)
  const paths = entries.map((entry: { path: string }) => entry.path.toLowerCase())
  expect(paths).not.toContain(lock.toLowerCase())
  expect(paths).toContain('.mimir/workspace.writer-lock.bak')
  expect(paths).toContain('notes/workspace.writer-lock')
})

it('清单包含文件与目录，路径为正斜杠相对路径，逐文件 SHA256 正确', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  mkdirSync(join(space, '.mimir/assets/files/1'), { recursive: true })
  writeFileSync(join(space, '.mimir/assets/files/1/a.txt'), 'hello')
  writeFileSync(join(space, '.mimir/assets/files/1/b.txt'), 'world')
  const { entries, totalBytes } = await buildManifest(space)
  const byPath = new Map(entries.map((e: any) => [e.path, e]))
  expect(byPath.get('.mimir/assets/files/1/a.txt')).toMatchObject({ kind: 'file', size: 5, sha256: sha('hello') })
  expect(byPath.get('.mimir/assets/files/1/b.txt')).toMatchObject({ kind: 'file', size: 5, sha256: sha('world') })
  expect(byPath.get('.mimir/assets/files/1')).toMatchObject({ kind: 'directory', size: 0, sha256: '' })
  expect(totalBytes).toBe(10)
})

it('排除 staging 暂存目录，不打包过程产物', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  mkdirSync(join(space, '.mimir/assets/staging'), { recursive: true })
  writeFileSync(join(space, '.mimir/assets/staging/temp.bin'), 'temp')
  mkdirSync(join(space, '.mimir/assets/files'), { recursive: true })
  writeFileSync(join(space, '.mimir/assets/files/keep.bin'), 'keep')
  const { entries } = await buildManifest(space)
  const paths = entries.map((e: any) => e.path)
  expect(paths).toContain('.mimir/assets/files/keep.bin')
  expect(paths.some((p: string) => p.includes('staging'))).toBe(false)
})

it('清单排序确定：同一空间重复生成结果一致', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  mkdirSync(join(space, 'b'), { recursive: true })
  mkdirSync(join(space, 'a'), { recursive: true })
  writeFileSync(join(space, 'b/2.txt'), '2')
  writeFileSync(join(space, 'a/1.txt'), '1')
  const first = (await buildManifest(space)).entries.map((e: any) => e.path)
  const second = (await buildManifest(space)).entries.map((e: any) => e.path)
  expect(first).toEqual(second)
  expect(first).toEqual([...first].sort())
})

it('符号链接/联接一律拒绝，不跟随到空间之外', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  writeFileSync(join(space, 'real.txt'), 'real')
  try {
    symlinkSync(join(space, 'real.txt'), join(space, 'link.txt'))
  } catch {
    return // 无权限创建链接的环境跳过（Windows 需开发者模式）
  }
  await expect(buildManifest(space)).rejects.toThrow()
})

/** 测试用上限：单文件上限默认设为很大，避免干扰条目数/总量用例。 */
const limits = (over: Partial<{ maxEntries: number; maxManifestBytes: number; maxTotalBytes: number; maxFileBytes: number }> = {}) => ({
  maxEntries: 100_000, maxManifestBytes: 1 << 20, maxTotalBytes: 1 << 20, maxFileBytes: 1 << 30, ...over
})

it('条目数超过上限抛错而非截断', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  for (let i = 0; i < 5; i++) writeFileSync(join(space, `f${i}.txt`), String(i))
  await expect(buildManifest(space, limits({ maxEntries: 3 })))
    .rejects.toThrow(/条目数超过上限/)
})

it('展开总字节超过上限抛错', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  writeFileSync(join(space, 'big.bin'), 'x'.repeat(100))
  await expect(buildManifest(space, limits({ maxTotalBytes: 50 })))
    .rejects.toThrow(/展开总字节超过上限/)
})

it('上限类错误可被识别，IO 类不可', async () => {
  const { buildManifest, isManifestLimitError } = await moduleUnderTest()
  const space = root()
  writeFileSync(join(space, 'f.txt'), 'f')
  try {
    await buildManifest(space, limits({ maxEntries: 0 }))
    expect.unreachable()
  } catch (error) {
    expect(isManifestLimitError(error)).toBe(true)
  }
  expect(isManifestLimitError(new Error('plain'))).toBe(false)
})

it('超限单文件收集为未纳入项并排除，备份继续而非整体失败', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  mkdirSync(join(space, 'data'), { recursive: true })
  writeFileSync(join(space, 'data/huge.bin'), 'x'.repeat(200))
  writeFileSync(join(space, 'data/ok.bin'), 'small')
  const { entries, excluded, totalBytes } = await buildManifest(space, limits({ maxFileBytes: 100 }))

  // 超限文件：进 excluded、不进 entries、不计入 totalBytes
  const paths = entries.map((e: any) => e.path)
  expect(paths).not.toContain('data/huge.bin')
  expect(paths).toContain('data/ok.bin')
  expect(excluded).toHaveLength(1)
  expect(excluded[0]).toMatchObject({ path: 'data/huge.bin', reason: 'oversize', size: 200, defaultDisposition: 'exclude' })
  expect(totalBytes).toBe(5)

  // 未纳入项排序稳定（可跨次比对）
  expect(excluded.map((e: any) => e.path)).toEqual([...excluded.map((e: any) => e.path)].sort())
})

it('未超限文件正常纳入，excluded 为空', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  writeFileSync(join(space, 'a.bin'), 'x'.repeat(100))
  const { entries, excluded } = await buildManifest(space, limits({ maxFileBytes: 100 }))
  // 边界：恰好等于上限视为纳入（用 > 而非 >=）
  expect(entries.map((e: any) => e.path)).toContain('a.bin')
  expect(excluded).toEqual([])
})

it('总量上限与单文件上限各自独立：单文件超限不至于抛错', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  writeFileSync(join(space, 'huge.bin'), 'x'.repeat(500))
  // maxTotalBytes 很小，但超限文件已被排除，故不会触发 TOTAL_LIMIT
  const { entries, excluded } = await buildManifest(space, limits({ maxTotalBytes: 10, maxFileBytes: 100 }))
  expect(excluded).toHaveLength(1)
  expect(entries.filter((e: any) => e.kind === 'file')).toHaveLength(0)
})

/** 判断清单里是否存在以给定后缀结尾的条目（大小写不敏感）。 */
const hasSuffixEntry = (paths: string[], suffix: string) =>
  paths.some(p => p.toLowerCase().endsWith(suffix))

it.each(['-wal', '-shm', '-journal'])('普通文件及目录仅以后缀%s命名，仍完整保留', async suffix => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  const files = [`notes/实验${suffix}`, `.hidden/项目${suffix}/记录.txt`, `other/cache.db${suffix}`, `.mimir/assets/custom${suffix}`]
  for (const file of files) {
    mkdirSync(dirname(join(space, file)), { recursive: true })
    writeFileSync(join(space, file), `user data ${file}`)
  }
  const { entries } = await buildManifest(space)
  const fileEntries = entries.filter((entry: { kind: string }) => entry.kind === 'file')
  expect(fileEntries.map((entry: { path: string }) => entry.path).sort()).toEqual([...files].sort())
  for (const file of files) {
    expect(fileEntries.find((entry: { path: string }) => entry.path === file).sha256).toBe(sha(`user data ${file}`))
  }
})

it('SQLite 瞬态文件（-wal/-shm/-journal）不进清单，稳定内容仍进', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  // 造一个空间根：主库 + 三个瞬态姊妹文件 + 一份正常文件。
  mkdirSync(join(space, '.mimir/assets'), { recursive: true })
  writeFileSync(join(space, '.mimir/assets/assets.db'), 'db-content')
  writeFileSync(join(space, '.mimir/assets/assets.db-wal'), 'wal-content')
  writeFileSync(join(space, '.mimir/assets/assets.db-shm'), 'shm-content')
  writeFileSync(join(space, '.mimir/assets/assets.db-journal'), 'journal-content')
  mkdirSync(join(space, 'notes'), { recursive: true })
  writeFileSync(join(space, 'notes/a.txt'), 'note')

  const { entries } = await buildManifest(space)
  const paths = entries.map((e: any) => e.path)

  // 稳定内容：进入清单。
  expect(paths).toContain('.mimir/assets/assets.db')
  expect(paths).toContain('notes/a.txt')
  // 瞬态文件：一律不进清单。
  expect(hasSuffixEntry(paths, '-wal')).toBe(false)
  expect(hasSuffixEntry(paths, '-shm')).toBe(false)
  expect(hasSuffixEntry(paths, '-journal')).toBe(false)
})

it('瞬态文件后缀匹配大小写不敏感（assets.db-WAL 也不进清单）', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  mkdirSync(join(space, '.mimir/assets'), { recursive: true })
  writeFileSync(join(space, '.mimir/assets/assets.db'), 'db-content')
  writeFileSync(join(space, '.mimir/assets/assets.db-WAL'), 'wal-content')
  writeFileSync(join(space, '.mimir/assets/assets.db-SHM'), 'shm-content')

  const { entries } = await buildManifest(space)
  const paths = entries.map((e: any) => e.path)

  expect(paths).toContain('.mimir/assets/assets.db')
  expect(hasSuffixEntry(paths, '-wal')).toBe(false)
  expect(hasSuffixEntry(paths, '-shm')).toBe(false)
})

it('后缀排除不误伤合法文件：以 .bak 结尾或以其它名字命名的文件仍进清单', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  mkdirSync(join(space, 'data'), { recursive: true })
  // 以 `.bak` 结尾 → 不是 `-wal` 结尾，必须保留（endsWith 而非 includes）。
  writeFileSync(join(space, 'data/archive-wal.bak'), 'backup')
  // 普通命名，必须保留。
  writeFileSync(join(space, 'data/my-database.db'), 'db')

  const { entries } = await buildManifest(space)
  const paths = entries.map((e: any) => e.path)

  expect(paths).toContain('data/archive-wal.bak')
  expect(paths).toContain('data/my-database.db')
})
