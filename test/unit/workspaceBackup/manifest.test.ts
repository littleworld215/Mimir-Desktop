import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'mimir-manifest-')); roots.push(value); return value }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })
async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/manifest.ts')).catch(() => ({} as any))
  expect(mod.buildManifest).toBeTypeOf('function')
  return mod
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

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
