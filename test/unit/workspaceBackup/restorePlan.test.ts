import { expect, it } from 'vitest'
import { join } from 'node:path'

async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restorePlan.ts')).catch(() => ({} as any))
  expect(mod.planRestore).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  expect(mod.RestoreError).toBeTypeOf('function')
  return mod
}

const verified = { entries: 42, totalBytes: 1024 * 1024, formatVersion: 1 }
const base = {
  archivePath: 'C:/backups/space-20261005.zip',
  targetRoot: 'C:/spaces/恢复的新空间',
  targetExists: false,
  verified,
  stagingToken: 'abc123'
}

// ─── 通过组 ────────────────────────────────────────────────────────

it('目标不存在时产出计划：目标/暂存根/条目数/字节数/格式版本', async () => {
  const { planRestore } = await moduleUnderTest()
  const plan = planRestore(base)
  expect(plan.archivePath).toBe('C:/backups/space-20261005.zip')
  expect(plan.targetRoot).toBe('C:/spaces/恢复的新空间')
  expect(plan.entries).toBe(42)
  expect(plan.totalBytes).toBe(1024 * 1024)
  expect(plan.formatVersion).toBe(1)
})

it('暂存根与目标同父目录、以点开头、带 token（保证同盘原子 rename）', async () => {
  const { planRestore } = await moduleUnderTest()
  const plan = planRestore(base)
  expect(plan.stagingRoot).toBe('C:/spaces/.mimir-restore-staging-abc123')
  // 同父目录
  expect(plan.stagingRoot.slice(0, plan.stagingRoot.lastIndexOf('/')))
    .toBe(plan.targetRoot.slice(0, plan.targetRoot.lastIndexOf('/')))
  // 以点开头（不进入任何清单）
  expect(plan.stagingRoot.split('/').pop()!.startsWith('.')).toBe(true)
})

it('POSIX 绝对路径同样支持（跨平台纯字符串推导）', async () => {
  const { planRestore } = await moduleUnderTest()
  const plan = planRestore({ ...base, targetRoot: '/home/me/spaces/new' })
  expect(plan.stagingRoot).toBe('/home/me/spaces/.mimir-restore-staging-abc123')
})

// ─── 失败组：TARGET_EXISTS 必须真的拒绝 ─────────────────────────────

it('目标已存在 → 抛 TARGET_EXISTS（拒绝覆盖，不是返回标志位）', async () => {
  const { planRestore } = await moduleUnderTest()
  const { RestoreError } = await contracts()
  try {
    planRestore({ ...base, targetExists: true })
    throw new Error('应当拒绝覆盖')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect((error as { code: string }).code).toBe('TARGET_EXISTS')
  }
})

it.each([
  ['C:/backups/x.zip', 'relative/target'],
  ['C:/backups/x.zip', ''],
  ['relative-archive.zip', 'C:/spaces/new']
])('非绝对路径拒绝 INVALID_TARGET (archive=%s, target=%s)', async (archivePath, targetRoot) => {
  const { planRestore } = await moduleUnderTest()
  const { RestoreError } = await contracts()
  try {
    planRestore({ ...base, archivePath, targetRoot })
    throw new Error('应当拒绝非绝对路径')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect((error as { code: string }).code).toBe('INVALID_TARGET')
  }
})

it('空 stagingToken 拒绝 INVALID_TARGET', async () => {
  const { planRestore } = await moduleUnderTest()
  const { RestoreError } = await contracts()
  try {
    planRestore({ ...base, stagingToken: '  ' })
    throw new Error('应当拒绝空 token')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect((error as { code: string }).code).toBe('INVALID_TARGET')
  }
})

it('目标路径含反斜杠时规范化为正斜杠（与备份清单口径一致）', async () => {
  const { planRestore } = await moduleUnderTest()
  const plan = planRestore({ ...base, targetRoot: 'C:\\spaces\\新空间\\' })
  expect(plan.targetRoot).toBe('C:/spaces/新空间')
})
