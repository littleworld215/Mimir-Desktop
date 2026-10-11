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

it('条目数超过上限抛错而非截断', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  for (let i = 0; i < 5; i++) writeFileSync(join(space, `f${i}.txt`), String(i))
  await expect(buildManifest(space, { maxEntries: 3, maxManifestBytes: 1 << 20, maxTotalBytes: 1 << 20 }))
    .rejects.toThrow(/条目数超过上限/)
})

it('展开总字节超过上限抛错', async () => {
  const { buildManifest } = await moduleUnderTest()
  const space = root()
  writeFileSync(join(space, 'big.bin'), 'x'.repeat(100))
  await expect(buildManifest(space, { maxEntries: 100, maxManifestBytes: 1 << 20, maxTotalBytes: 50 }))
    .rejects.toThrow(/展开总字节超过上限/)
})

it('上限类错误可被识别，IO 类不可', async () => {
  const { buildManifest, isManifestLimitError } = await moduleUnderTest()
  const space = root()
  writeFileSync(join(space, 'f.txt'), 'f')
  try {
    await buildManifest(space, { maxEntries: 0, maxManifestBytes: 1 << 20, maxTotalBytes: 1 << 20 })
    expect.unreachable()
  } catch (error) {
    expect(isManifestLimitError(error)).toBe(true)
  }
  expect(isManifestLimitError(new Error('plain'))).toBe(false)
})
