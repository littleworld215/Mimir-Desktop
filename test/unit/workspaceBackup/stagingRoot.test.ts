import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
function workDir() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-staging-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function subject() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/stagingRoot.ts')).catch(() => ({} as any))
  expect(mod.createStagingRoot).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  return mod
}

// ─── 通过组 ────────────────────────────────────────────────────────

it('由目标路径推导暂存根：同父目录、以点开头、带 token', async () => {
  const { stagingPathFor } = await subject()
  expect(stagingPathFor('C:/spaces/新空间', 'abc')).toBe('C:/spaces/.mimir-restore-staging-abc')
})

it('独占创建暂存根成功', async () => {
  const { createStagingRoot } = await subject()
  const dir = workDir()
  const target = join(dir, 'spaces/new')
  mkdirSync(join(dir, 'spaces'))
  const staging = createStagingRoot(target.replace(/\\/g, '/'), 'tok1')
  expect(staging.owned).toBe(true)
  expect(existsSync(staging.root)).toBe(true)
})

// ─── 失败组 ────────────────────────────────────────────────────────

it('暂存根已存在 → 拒绝复用（STAGING_CONFLICT）', async () => {
  const { createStagingRoot, stagingPathFor } = await subject()
  const { RestoreError } = await contracts()
  const dir = workDir()
  const target = join(dir, 'spaces/new').replace(/\\/g, '/')
  mkdirSync(join(dir, 'spaces'))
  mkdirSync(stagingPathFor(target, 'dup'))
  try {
    createStagingRoot(target, 'dup')
    throw new Error('应当拒绝复用')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect((error as { code: string }).code).toBe('STAGING_CONFLICT')
  }
})

it('父目录不存在 → 拒绝（INVALID_TARGET，须先做磁盘校验）', async () => {
  const { createStagingRoot } = await subject()
  const { RestoreError } = await contracts()
  const dir = workDir()
  try {
    createStagingRoot(`${dir.replace(/\\/g, '/')}/missing/new`, 'x')
    throw new Error('应当拒绝')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect((error as { code: string }).code).toBe('INVALID_TARGET')
  }
})

// ─── 清理边界组 ────────────────────────────────────────────────────

it('cleanup 只删本次暂存根，原空间与原注册表逐字保留', async () => {
  const { createStagingRoot, cleanupStagingRoot } = await subject()
  const dir = workDir()
  // 原空间 + 原注册表
  const originalSpace = join(dir, 'Mimir/我的科研空间')
  mkdirSync(join(originalSpace, '.mimir'), { recursive: true })
  writeFileSync(join(originalSpace, '.mimir/store.json'), '{"业务":"原样"}')
  const registry = join(dir, '.mimir/store.json')
  mkdirSync(join(dir, '.mimir'), { recursive: true })
  writeFileSync(registry, '{"workspaces:list":[]}')

  const target = join(dir, 'spaces/new').replace(/\\/g, '/')
  mkdirSync(join(dir, 'spaces'))
  const staging = createStagingRoot(target, 'clean')
  writeFileSync(join(staging.root, 'junk.txt'), 'x')
  cleanupStagingRoot(staging.root)

  expect(existsSync(staging.root)).toBe(false)
  // 原空间/原注册表**逐字未变**。
  expect(readFileSync(join(originalSpace, '.mimir/store.json'), 'utf8')).toBe('{"业务":"原样"}')
  expect(readFileSync(registry, 'utf8')).toBe('{"workspaces:list":[]}')
})

it('cleanup 对不存在的暂存根幂等（不抛）', async () => {
  const { cleanupStagingRoot } = await subject()
  const dir = workDir()
  expect(() => cleanupStagingRoot(`${dir.replace(/\\/g, '/')}/.mimir-restore-staging-none`)).not.toThrow()
})
