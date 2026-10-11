import { expect, it } from 'vitest'
import { join } from 'node:path'

async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/remapRules.ts')).catch(() => ({} as any))
  expect(mod.REMAP_WHITELIST).toBeTruthy()
  expect(mod.matchRootPrefix).toBeTypeOf('function')
  expect(mod.replaceRootPrefix).toBeTypeOf('function')
  expect(mod.isAbsolutePathLike).toBeTypeOf('function')
  expect(mod.normalizeRootForMatch).toBeTypeOf('function')
  return mod
}

// 单测显式传 opts：不依赖运行平台（win32 下也能覆盖大小写敏感分支）
const OPTS = { caseInsensitive: false, separator: '/' as const }

// ─── 白名单锁：防后人偷偷扩大改写面 ─────────────────────────────────

it('REMAP_WHITELIST 只有一条，且字段就是 pdfPath（扩大改写面必须回传复核）', async () => {
  const { REMAP_WHITELIST } = await moduleUnderTest()
  expect(REMAP_WHITELIST).toHaveLength(1)
  expect(REMAP_WHITELIST[0].storeKey).toBe('library:papers')
  expect(REMAP_WHITELIST[0].field).toBe('pdfPath')
})

it('白名单不含任何其它已知路径字段（paperDir / file_path / external_url 一律不在内）', async () => {
  const { REMAP_WHITELIST } = await moduleUnderTest()
  const fields = REMAP_WHITELIST.map((rule: any) => rule.field)
  expect(fields).not.toContain('paperDir')
  expect(fields).not.toContain('file_path')
  expect(fields).not.toContain('external_url')
})

// ─── isAbsolutePathLike ────────────────────────────────────────────

it.each([
  ['C:/old/space', true],
  ['C:\\old\\space', true],
  ['/old/space', true],
  ['/old', true],
  ['http://arxiv.org/pdf/2103.00020v2', false],
  ['https://example.com/a/b', false],
  ['papers/2103.00020v2.pdf', false],
  ['./papers/x.pdf', false],
  ['', false],
  ['相对路径/x.pdf', false]
])('isAbsolutePathLike(%j) === %j', async (value, expected) => {
  const { isAbsolutePathLike } = await moduleUnderTest()
  expect(isAbsolutePathLike(value)).toBe(expected)
})

// ─── matchRootPrefix：路径边界（防误伤的核心边界） ──────────────────

it.each([
  ['/a/b', true, ''],
  ['/a/b/papers/x.pdf', true, 'papers/x.pdf'],
  ['/a/bc/papers/x.pdf', false, null], // ⚠️ 同级前缀目录：必须不命中
  ['/a', false, null],
  ['/a/b2', false, null],
  ['papers/x.pdf', false, null],
  ['', false, null],
  ['http://arxiv.org/a/b', false, null]
])('老根 /a/b 对 %j → matched=%j', async (value, matched, rest) => {
  const { matchRootPrefix } = await moduleUnderTest()
  expect(matchRootPrefix(value as string, '/a/b', OPTS)).toEqual({ matched, rest })
})

it('老根带尾分隔符 /a/b/ 仍能命中（归一化生效）', async () => {
  const { matchRootPrefix } = await moduleUnderTest()
  expect(matchRootPrefix('/a/b/papers/x.pdf', '/a/b/', OPTS)).toEqual({ matched: true, rest: 'papers/x.pdf' })
  expect(matchRootPrefix('/a/b', '/a/b/', OPTS)).toEqual({ matched: true, rest: '' })
})

it('老根含 .. 与重复分隔符也能归一化后命中', async () => {
  const { matchRootPrefix } = await moduleUnderTest()
  expect(matchRootPrefix('/a/b/papers/x.pdf', '/a/c/../b//', OPTS)).toEqual({ matched: true, rest: 'papers/x.pdf' })
})

it('normalizeRootForMatch 去尾分隔符并按大小写选项处理', async () => {
  const { normalizeRootForMatch } = await moduleUnderTest()
  expect(normalizeRootForMatch('/a/b/', { caseInsensitive: false })).toBe('/a/b')
  expect(normalizeRootForMatch('C:\\Old\\', { caseInsensitive: false })).toBe('C:/Old')
  expect(normalizeRootForMatch('C:\\Old', { caseInsensitive: true })).toBe('c:/old')
  expect(normalizeRootForMatch('C:\\Old', { caseInsensitive: false })).toBe('C:/Old')
})

// ─── 大小写：显式 opts，不依赖平台 ──────────────────────────────────

it('caseInsensitive:false 时 C:\\Old 与 c:\\old 不命中', async () => {
  const { matchRootPrefix } = await moduleUnderTest()
  expect(matchRootPrefix('C:\\Old\\papers\\x.pdf', 'c:\\old', { ...OPTS, caseInsensitive: false }).matched).toBe(false)
})

it('caseInsensitive:true 时 C:\\Old 与 c:\\old 命中', async () => {
  const { matchRootPrefix } = await moduleUnderTest()
  const result = matchRootPrefix('C:\\Old\\papers\\x.pdf', 'c:\\old', { caseInsensitive: true, separator: '\\' })
  expect(result).toEqual({ matched: true, rest: 'papers/x.pdf' })
})

// ─── replaceRootPrefix ─────────────────────────────────────────────

it('Windows 反斜杠路径能正确拼接新根（保留原大小写与尾段）', async () => {
  const { replaceRootPrefix } = await moduleUnderTest()
  const next = replaceRootPrefix('C:\\Old\\Space\\papers\\2103.00020v2.pdf', 'C:\\Old\\Space', 'D:\\New\\Space', {
    caseInsensitive: true,
    separator: '\\'
  })
  expect(next).toBe('D:\\New\\Space\\papers\\2103.00020v2.pdf')
})

it('老根新根大小写不同也能改写（值本身保持原样）', async () => {
  const { replaceRootPrefix } = await moduleUnderTest()
  const next = replaceRootPrefix('c:\\old\\space\\papers\\a.pdf', 'C:\\Old\\Space', 'D:/New/Space', {
    caseInsensitive: true,
    separator: '/'
  })
  expect(next).toBe('D:/New/Space/papers/a.pdf')
})

it('值等于老根时直接换成新根（rest 为空）', async () => {
  const { replaceRootPrefix } = await moduleUnderTest()
  expect(replaceRootPrefix('/a/b', '/a/b', '/new/root', OPTS)).toBe('/new/root')
})

it('未命中返回 null（调用方据此原样保留）', async () => {
  const { replaceRootPrefix } = await moduleUnderTest()
  expect(replaceRootPrefix('/a/bc/papers/x.pdf', '/a/b', '/new/root', OPTS)).toBeNull()
  expect(replaceRootPrefix('http://arxiv.org/pdf/1', '/a/b', '/new/root', OPTS)).toBeNull()
  expect(replaceRootPrefix('', '/a/b', '/new/root', OPTS)).toBeNull()
})

it('新根带尾分隔符时不产生双分隔符', async () => {
  const { replaceRootPrefix } = await moduleUnderTest()
  expect(replaceRootPrefix('/a/b/papers/x.pdf', '/a/b', '/new/root/', OPTS)).toBe('/new/root/papers/x.pdf')
})
