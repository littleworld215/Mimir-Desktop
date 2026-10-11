import { expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * rename 失败注入开关。
 *
 * 只篡改 `renameSync`，其余 fs 能力走 `importOriginal` 的真实实现——这样临时目录、
 * 快照复制、原子写前半段都是**真实**的，只有「rename 这一步」被人为失败，
 * 从而真实复现「写入失败 → REGISTER_FAILED 且原文件未被改写」。
 */
const control = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (control.failRename) throw new Error('EPERM: 模拟 rename 失败（测试注入）')
      return actual.renameSync(from, to)
    }
  }
})

async function subject() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/registryAppend.ts')).catch(() => ({} as any))
  expect(mod.appendWorkspaceRecord).toBeTypeOf('function')
  expect(mod.snapshotRegistryFile).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  expect(mod.RestoreError).toBeTypeOf('function')
  return mod
}
async function overview() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/registryView.ts')).catch(() => ({} as any))
  expect(mod.readRegistryOverview).toBeTypeOf('function')
  return mod
}

const homes: string[] = []
/** 合成 home：**绝不**写真实 `~/.mimir`。 */
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-registry-append-'))
  homes.push(root)
  return root
}
afterEach(() => {
  control.failRename = false
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ORIGINAL = JSON.stringify(
  {
    settings: { apiKey: 'synthetic-secret', theme: 'dark' },
    'servers:list': [{ name: 's1', password: 'synthetic-password' }],
    activeWorkspaceId: 'old-space',
    defaultWorkspaceId: 'old-space',
    'workspaces:list': [{ id: 'old-space', name: '旧空间', path: 'C:/spaces/old', createdAt: 'c', updatedAt: 'u' }]
  },
  null,
  2
)

/** 在合成 home 里种一份注册表，返回其路径。 */
function seedRegistry(root: string): string {
  mkdirSync(join(root, '.mimir'), { recursive: true })
  const path = join(root, '.mimir', 'store.json')
  writeFileSync(path, ORIGINAL, 'utf8')
  return path
}

const NEW_SPACE = { id: 'new-space-uuid', name: '恢复的新空间', path: 'C:/spaces/restored', createdAt: 'c2', updatedAt: 'u2' }

// ─── 通过组：只追加 ─────────────────────────────────────────────────

it('追加后 workspaces:list 多一条，新增记录字段完整', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  const path = seedRegistry(root)
  const outcome = appendWorkspaceRecord(root, NEW_SPACE)
  expect(outcome.appended).toBe(true)
  expect(outcome.spaces).toBe(2)

  const after = JSON.parse(readFileSync(path, 'utf8'))
  expect(after['workspaces:list']).toHaveLength(2)
  expect(after['workspaces:list'][1]).toEqual(NEW_SPACE)
})

it('settings / servers:list / activeWorkspaceId / defaultWorkspaceId 逐字不变（S1）', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  const path = seedRegistry(root)
  const before = JSON.parse(readFileSync(path, 'utf8'))
  appendWorkspaceRecord(root, NEW_SPACE)
  const after = JSON.parse(readFileSync(path, 'utf8'))
  expect(after.settings).toEqual(before.settings)
  expect(after['servers:list']).toEqual(before['servers:list'])
  expect(after.activeWorkspaceId).toBe('old-space')
  expect(after.defaultWorkspaceId).toBe('old-space')
  // 逐键字符串化比对：防止「toEqual 通过但某键被改写」的假绿
  expect(JSON.stringify(after.settings)).toBe(JSON.stringify(before.settings))
  expect(JSON.stringify(after['servers:list'])).toBe(JSON.stringify(before['servers:list']))
})

it('原记录逐字不变（只追加，不修改既有条目）', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  const path = seedRegistry(root)
  const before = JSON.parse(readFileSync(path, 'utf8'))
  appendWorkspaceRecord(root, NEW_SPACE)
  const after = JSON.parse(readFileSync(path, 'utf8'))
  expect(after['workspaces:list'][0]).toEqual(before['workspaces:list'][0])
})

// ─── 快照：存在 + 字节等于写入前的原文件 ─────────────────────────────

it('快照文件存在、命名带 .pre-restore- 前缀、字节等于写入前的原文件（S3）', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  seedRegistry(root)
  const outcome = appendWorkspaceRecord(root, NEW_SPACE)
  expect(existsSync(outcome.snapshotPath)).toBe(true)
  expect(outcome.snapshotPath).toContain('.pre-restore-')
  expect(readFileSync(outcome.snapshotPath, 'utf8')).toBe(ORIGINAL)
})

it('snapshotRegistryFile 单独调用也产出字节一致的快照', async () => {
  const { snapshotRegistryFile } = await subject()
  const root = home()
  seedRegistry(root)
  const snapshot = snapshotRegistryFile(root)
  expect(readFileSync(snapshot, 'utf8')).toBe(ORIGINAL)
})

it('注册表文件不存在 → 快照报 REGISTRY_INVALID', async () => {
  const { snapshotRegistryFile } = await subject()
  const root = home()
  try {
    snapshotRegistryFile(root)
    throw new Error('应当在注册表缺失时失败')
  } catch (error) {
    expect((error as any).code).toBe('REGISTRY_INVALID')
  }
})

// ─── 写后复核 ───────────────────────────────────────────────────────

it('写后复核能读到新 id（readRegistryOverview 验证）', async () => {
  const { appendWorkspaceRecord } = await subject()
  const { readRegistryOverview } = await overview()
  const root = home()
  seedRegistry(root)
  appendWorkspaceRecord(root, NEW_SPACE)
  const view = readRegistryOverview(root)
  expect(view.some((space: any) => space.id === NEW_SPACE.id)).toBe(true)
  expect(view.map((space: any) => space.id)).toEqual(['old-space', NEW_SPACE.id])
})

// ─── 幂等组（S9） ───────────────────────────────────────────────────

it('同一 id 追加两次 → 第二次 appended:false，条目数不变', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  const path = seedRegistry(root)
  const first = appendWorkspaceRecord(root, NEW_SPACE)
  const second = appendWorkspaceRecord(root, NEW_SPACE)
  expect(first.appended).toBe(true)
  expect(second.appended).toBe(false)
  expect(second.spaces).toBe(2)
  expect(JSON.parse(readFileSync(path, 'utf8'))['workspaces:list']).toHaveLength(2)
})

// ─── 失败组：rename 失败 → REGISTER_FAILED，原文件未被改写 ───────────

it('rename 失败 → REGISTER_FAILED，原 store.json 逐字未被改写，临时文件已清理', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  const path = seedRegistry(root)
  control.failRename = true
  try {
    appendWorkspaceRecord(root, NEW_SPACE)
    throw new Error('应当在写入失败时报失败')
  } catch (error) {
    expect((error as any).code).toBe('REGISTER_FAILED')
  }
  // 原文件逐字未变（原子写的价值：写一半失败也不污染原文件）
  expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)
  // 临时文件已清理（不留下半成品）
  expect(readdirSync(join(root, '.mimir')).filter((name) => name.startsWith('.tmp-'))).toHaveLength(0)
})

// ─── 失败组：注册表损坏 / 入参非法 ───────────────────────────────────

it.each(['not-json', '[]', '{"workspaces:list":{}}'])('损坏注册表不写入（%s）→ REGISTRY_INVALID，原文件逐字不变', async (raw) => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  mkdirSync(join(root, '.mimir'), { recursive: true })
  const path = join(root, '.mimir', 'store.json')
  writeFileSync(path, raw, 'utf8')
  try {
    appendWorkspaceRecord(root, NEW_SPACE)
    throw new Error('应当在注册表损坏时失败')
  } catch (error) {
    expect((error as any).code).toBe('REGISTRY_INVALID')
  }
  expect(readFileSync(path, 'utf8')).toBe(raw)
})

it('空间路径非绝对 → REGISTRY_INVALID，原文件逐字不变（S7）', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  const path = seedRegistry(root)
  try {
    appendWorkspaceRecord(root, { ...NEW_SPACE, path: 'relative/spaces/restored' })
    throw new Error('应当在相对路径时失败')
  } catch (error) {
    expect((error as any).code).toBe('REGISTRY_INVALID')
  }
  expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)
})

it('id 为空 → REGISTRY_INVALID，原文件逐字不变', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  const path = seedRegistry(root)
  try {
    appendWorkspaceRecord(root, { ...NEW_SPACE, id: '  ' })
    throw new Error('应当在空 id 时失败')
  } catch (error) {
    expect((error as any).code).toBe('REGISTRY_INVALID')
  }
  expect(readFileSync(path, 'utf8')).toBe(ORIGINAL)
})

// ─── S2/K3 防线：不创建默认空间 ─────────────────────────────────────

it('home 下不出现除 .mimir 之外的目录（未创建默认空间、未 loadStore）', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  seedRegistry(root)
  const outcome = appendWorkspaceRecord(root, NEW_SPACE)
  expect(readdirSync(root)).toEqual(['.mimir'])
  const inside = readdirSync(join(root, '.mimir')).sort()
  expect(inside).toHaveLength(2)
  expect(inside).toContain('store.json')
  expect(inside).toContain(outcome.snapshotPath.split(/[\\/]/).pop())
})

it('空注册表（无 workspaces:list）也能只追加，不创建默认空间', async () => {
  const { appendWorkspaceRecord } = await subject()
  const root = home()
  mkdirSync(join(root, '.mimir'), { recursive: true })
  const path = join(root, '.mimir', 'store.json')
  writeFileSync(path, JSON.stringify({ settings: {} }), 'utf8')
  const outcome = appendWorkspaceRecord(root, NEW_SPACE)
  expect(outcome.appended).toBe(true)
  expect(outcome.spaces).toBe(1)
  const after = JSON.parse(readFileSync(path, 'utf8'))
  expect(after['workspaces:list']).toHaveLength(1)
  expect(after.settings).toEqual({})
  expect(after.activeWorkspaceId).toBeUndefined()
  expect(readdirSync(root)).toEqual(['.mimir'])
})

it('RestoreError 类型可用（错误码契约一致）', async () => {
  const { RestoreError } = await contracts()
  const error = new RestoreError('REGISTER_FAILED', 'x')
  expect(error.name).toBe('RestoreError')
  expect(error.code).toBe('REGISTER_FAILED')
})
