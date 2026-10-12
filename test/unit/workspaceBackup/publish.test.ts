import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function subject() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/publish.ts')).catch(() => ({} as any))
  expect(mod.publishStagedSpace).toBeTypeOf('function')
  expect(mod.assertPublishableStaging).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  expect(mod.RestoreError).toBeTypeOf('function')
  return mod
}

const roots: string[] = []
function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-publish-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 构造一个「已解压并复校通过」的暂存根：含 .mimir/store.json 与 papers/ 内容。 */
function makeStaging(root: string): string {
  const staging = join(root, '.mimir-restore-staging-abc123')
  mkdirSync(join(staging, '.mimir'), { recursive: true })
  mkdirSync(join(staging, 'papers'), { recursive: true })
  writeFileSync(join(staging, '.mimir', 'store.json'), JSON.stringify({ 'library:papers': {} }), 'utf8')
  writeFileSync(join(staging, 'papers', '2103.00020v2.pdf'), 'PDF-BYTES', 'utf8')
  return staging
}

// ─── 通过组：同盘原子发布 ───────────────────────────────────────────

it('发布成功：暂存根消失、目标出现、内容完整', async () => {
  const { publishStagedSpace } = await subject()
  const root = workDir()
  const staging = makeStaging(root)
  const target = join(root, '恢复的新空间')

  const outcome = publishStagedSpace(staging, target)

  expect(outcome.targetRoot).toBe(target)
  expect(existsSync(staging)).toBe(false) // 暂存根被 rename 消费
  expect(existsSync(target)).toBe(true)
  expect(readFileSync(join(target, 'papers', '2103.00020v2.pdf'), 'utf8')).toBe('PDF-BYTES')
  expect(readFileSync(join(target, '.mimir', 'store.json'), 'utf8')).toBe(JSON.stringify({ 'library:papers': {} }))
})

// ─── 失败组：TARGET_EXISTS 绝不覆盖，且不改动既有目录 ────────────────

it('目标目录已存在 → 抛 TARGET_EXISTS，既有目录逐字未动、暂存根保留', async () => {
  const { publishStagedSpace } = await subject()
  const { RestoreError } = await contracts()
  const root = workDir()
  const staging = makeStaging(root)
  const target = join(root, '既有空间')
  mkdirSync(join(target, 'papers'), { recursive: true })
  writeFileSync(join(target, 'papers', 'mine.pdf'), '既有内容', 'utf8')
  const before = readFileSync(join(target, 'papers', 'mine.pdf'), 'utf8')

  try {
    publishStagedSpace(staging, target)
    throw new Error('应当拒绝覆盖')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect((error as any).code).toBe('TARGET_EXISTS')
  }

  // 既有目录逐字未动
  expect(readFileSync(join(target, 'papers', 'mine.pdf'), 'utf8')).toBe(before)
  // 暂存根保留（供 retry）
  expect(existsSync(staging)).toBe(true)
  expect(existsSync(join(staging, 'papers', '2103.00020v2.pdf'))).toBe(true)
})

it('目标路径已存在为文件（非目录）也拒绝覆盖', async () => {
  const { publishStagedSpace } = await subject()
  const root = workDir()
  const staging = makeStaging(root)
  const target = join(root, '占位文件')
  writeFileSync(target, '占位', 'utf8')
  try {
    publishStagedSpace(staging, target)
    throw new Error('应当拒绝覆盖')
  } catch (error) {
    expect((error as any).code).toBe('TARGET_EXISTS')
  }
  expect(readFileSync(target, 'utf8')).toBe('占位')
})

it('暂存根不存在 → 抛 PUBLISH_FAILED（不是静默成功）', async () => {
  const { publishStagedSpace } = await subject()
  const root = workDir()
  try {
    publishStagedSpace(join(root, '不存在的暂存根'), join(root, '新空间'))
    throw new Error('应当在暂存根缺失时失败')
  } catch (error) {
    expect((error as any).code).toBe('PUBLISH_FAILED')
  }
})

// ─── 链接组：S8 链接拒绝 ────────────────────────────────────────────

/**
 * ⚠️ 沙箱替身说明（对齐设计 §4.3）：
 * 这里用 `symlinkSync(..., 'junction')` 构造链接。沙箱内能否真正生成 Windows junction
 * 取决于权限/开发者模式；即便生成成功，`isSymbolicLink()` 对 junction 的判定也与真实
 * 用户机器上的 junction 语义存在差异。**真实 junction 的创建与拒绝仍待真机验收**——
 * 本用例证明的是「只要 lstat 判定为链接就拒绝」，不是「真机 junction 已被验证」。
 */
it('.mimir 为链接 → 抛 UNSAFE_ENTRY，不发布', async () => {
  const { publishStagedSpace, assertPublishableStaging } = await subject()
  const root = workDir()
  const staging = makeStaging(root)
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'evil.json'), '{}', 'utf8')
  rmSync(join(staging, '.mimir'), { recursive: true, force: true })
  symlinkSync(outside, join(staging, '.mimir'), 'junction')

  expect(() => assertPublishableStaging(staging)).toThrow(/UNSAFE_ENTRY|链接/)
  try {
    publishStagedSpace(staging, join(root, '新空间'))
    throw new Error('应当在链接控制目录时拒绝发布')
  } catch (error) {
    expect((error as any).code).toBe('UNSAFE_ENTRY')
  }
  // 未发布：目标不存在，暂存根仍在
  expect(existsSync(join(root, '新空间'))).toBe(false)
  expect(existsSync(staging)).toBe(true)
})

it('assets 为链接 → 抛 UNSAFE_ENTRY，不发布', async () => {
  const { assertPublishableStaging } = await subject()
  const root = workDir()
  const staging = makeStaging(root)
  const outside = join(root, 'outside-assets')
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(staging, 'assets'), 'junction')
  try {
    assertPublishableStaging(staging)
    throw new Error('应当在链接资产目录时拒绝发布')
  } catch (error) {
    expect((error as any).code).toBe('UNSAFE_ENTRY')
  }
})

it('非链接的普通目录放行（不误伤）', async () => {
  const { assertPublishableStaging } = await subject()
  const root = workDir()
  const staging = makeStaging(root)
  mkdirSync(join(staging, 'assets'), { recursive: true })
  expect(() => assertPublishableStaging(staging)).not.toThrow()
})

// ─── 悬垂符号链接：存在性探测必须用 lstat 而非 existsSync ─────────────
/**
 * 回归守门用例（存量优化）。
 *
 * 原实现用 `existsSync(path)` 判「受保护目录是否存在」——但 `existsSync` 会**跟随**链接，
 * 悬垂符号链接（指向不存在的目标）被判为「不存在」而整体跳过该项检查，使悬垂链接**绕过 S8**。
 * 修法：改用 `lstatSync` 探测（不跟随链接），仅 `ENOENT` 才跳过。
 *
 * 本用例锁死该行为：悬垂链接**必须**被 `UNSAFE_ENTRY` 拒绝。
 */
it('.mimir 为**悬垂**符号链接 → 仍抛 UNSAFE_ENTRY（existsSync 会漏判，lstat 不漏）', async () => {
  const { assertPublishableStaging, publishStagedSpace } = await subject()
  const root = workDir()
  const staging = makeStaging(root)
  rmSync(join(staging, '.mimir'), { recursive: true, force: true })
  // 指向一个**不存在**的目标 → 悬垂链接；existsSync 对其返回 false。
  symlinkSync(join(root, 'no-such-target-dir'), join(staging, '.mimir'), 'junction')

  expect(() => assertPublishableStaging(staging)).toThrow(/UNSAFE_ENTRY|链接/)
  try {
    publishStagedSpace(staging, join(root, '新空间'))
    throw new Error('应当在控制目录为悬垂链接时拒绝发布')
  } catch (error) {
    expect((error as any).code).toBe('UNSAFE_ENTRY')
  }
  // 未发布：目标不存在，暂存根仍在
  expect(existsSync(join(root, '新空间'))).toBe(false)
  expect(existsSync(staging)).toBe(true)
})

it('assets 为**悬垂**符号链接 → 仍抛 UNSAFE_ENTRY', async () => {
  const { assertPublishableStaging } = await subject()
  const root = workDir()
  const staging = makeStaging(root)
  symlinkSync(join(root, 'no-such-assets-target'), join(staging, 'assets'), 'junction')
  try {
    assertPublishableStaging(staging)
    throw new Error('应当在资产目录为悬垂链接时拒绝发布')
  } catch (error) {
    expect((error as any).code).toBe('UNSAFE_ENTRY')
  }
})

