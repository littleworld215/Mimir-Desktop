import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

import {
  buildBackupHandler,
  normalizeBackupRequest,
  registerBackupHandler
} from '../../../electron/workspaceBackup/maintenanceBackupHandler'
import type { MaintenanceBackupResult } from '../../../shared/workspaceBackupContracts'

/**
 * 维护模式「逐空间完整备份」IPC 装配（I6 批次 3.5 · T04）。
 *
 * 目标：**不启动 Electron** 验证装配层的六组事（照 `maintenanceRetentionIpc.test.ts` 范式）：
 * 1. 规范化（合法 / 缺字段 / 非对象 / 空串 / 空格串 / 非字符串 / 超长 / **多余字段**）；
 * 2. 会话健康检查（`undefined` 或 `assertUsable` 抛错 → `LOCK_UNAVAILABLE` 且**零副作用**）；
 * 3. **自锁红线**（🔴 本任务最重要）：源码文本断言不调 `session.select()`、不 import electron；
 * 4. 单向裁剪（结果逐字段相等 + `JSON.stringify` 不含 `homeDir`）；
 * 5. sender 校验（非信任 → `UNAUTHORIZED_SENDER`）；
 * 6. 异常收敛（`runBackup` 抛错 → `BACKUP_FAILED`，**绝不外抛**）+ preload 契约文本对齐。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（test/unit/workspaceBackup → 上溯三级）。 */
const REPO_ROOT = join(HERE, '..', '..', '..')

/** 合成 home（形似 Windows 绝对路径，用于裁剪断言）。 */
const HOME = 'C:\\Users\\科研\\AppData\\Roaming\\mimir-home'

/** 一条成功的备份结果（不含任何路径字段——`archiveName` 是 basename）。 */
function okResult(overrides: Partial<Extract<MaintenanceBackupResult, { ok: true }>> = {}): MaintenanceBackupResult {
  return {
    ok: true,
    spaceId: 'abc',
    name: '我的空间',
    archiveName: 'mimir-backup-我的空间-20260708-100000.zip',
    entries: 3,
    totalBytes: 4096,
    archiveBytes: 2048,
    excluded: 0,
    hasAssetsDb: true,
    ...overrides
  }
}

/** 假 ipc：捕获注册用的 listener（照既有范式）。 */
function fakeIpc(): {
  captured: { channel?: string; listener?: (event: unknown, ...args: unknown[]) => unknown }[]
  ipc: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void }
} {
  const captured: { channel?: string; listener?: (event: unknown, ...args: unknown[]) => unknown }[] = []
  return {
    captured,
    ipc: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        captured.push({ channel, listener })
      }
    }
  }
}

// ── 1. 参数规范化（纯函数，严格） ───────────────────────────────────────

it('normalizeBackupRequest：合法 { spaceId: "abc" } → 通过', () => {
  expect(normalizeBackupRequest({ spaceId: 'abc' })).toEqual({ spaceId: 'abc' })
})

it('normalizeBackupRequest：缺字段 / 空串 / 空格串 / 非字符串 / 非对象 → 一律拒绝', () => {
  // 缺字段。
  expect(normalizeBackupRequest({})).toBeNull()
  // 空串。
  expect(normalizeBackupRequest({ spaceId: '' })).toBeNull()
  // 纯空格（trim 后为空）。
  expect(normalizeBackupRequest({ spaceId: '   ' })).toBeNull()
  // 非字符串。
  expect(normalizeBackupRequest({ spaceId: 123 })).toBeNull()
  // 非对象。
  expect(normalizeBackupRequest(null)).toBeNull()
  expect(normalizeBackupRequest(undefined)).toBeNull()
  expect(normalizeBackupRequest([])).toBeNull()
  expect(normalizeBackupRequest('abc')).toBeNull()
})

it('normalizeBackupRequest：**多余字段一律拒绝**（关键：防渲染层塞路径）', () => {
  // 渲染层试图夹带路径 / 其它字段 → 一律拒绝（K4：只收 spaceId）。
  expect(normalizeBackupRequest({ spaceId: 'abc', path: '/evil' })).toBeNull()
  expect(normalizeBackupRequest({ spaceId: 'abc', extra: 1 })).toBeNull()
  expect(normalizeBackupRequest({ spaceId: 'abc', archivePath: 'D:\\x.zip' })).toBeNull()
})

it('normalizeBackupRequest：spaceId 超长（> 512）→ 拒绝；边界 512 合法', () => {
  expect(normalizeBackupRequest({ spaceId: 'x'.repeat(513) })).toBeNull()
  expect(normalizeBackupRequest({ spaceId: 'x'.repeat(512) })).toEqual({ spaceId: 'x'.repeat(512) })
})

// ── 2. 会话健康检查 + 零副作用早退 ──────────────────────────────────────

it('backup()：session === undefined → LOCK_UNAVAILABLE，且 runBackup **未被调用**（零副作用）', async () => {
  let runCalled = false
  const handler = buildBackupHandler({
    homeDir: HOME,
    session: undefined,
    runBackup: async () => { runCalled = true; return okResult() }
  })
  const result = await handler.backup({ spaceId: 'abc' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('LOCK_UNAVAILABLE')
  // **关键**：一次都没有触达服务层（证明是早退，零副作用）。
  expect(runCalled).toBe(false)
})

it('backup()：assertUsable() 抛错 → LOCK_UNAVAILABLE，且 runBackup **未被调用**（零副作用）', async () => {
  let runCalled = false
  const handler = buildBackupHandler({
    homeDir: HOME,
    session: { assertUsable: () => { throw Error('会话已失效') } },
    runBackup: async () => { runCalled = true; return okResult() }
  })
  const result = await handler.backup({ spaceId: 'abc' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('LOCK_UNAVAILABLE')
  expect(runCalled).toBe(false)
})

it('backup()：非法入参 → INVALID_REQUEST，且 runBackup **未被调用**（规范组全走早退）', async () => {
  let runCalled = false
  const handler = buildBackupHandler({
    homeDir: HOME,
    session: { assertUsable: () => { /* 健康 */ } },
    runBackup: async () => { runCalled = true; return okResult() }
  })
  const badInputs: unknown[] = [
    {},
    { spaceId: '' },
    { spaceId: '   ' },
    { spaceId: 123 },
    { spaceId: 'abc', path: '/evil' },
    null,
    undefined,
    'plain-string',
    ['abc'],
    { id: 'abc' } // 字段名写错（只有 spaceId 才认）
  ]
  for (const bad of badInputs) {
    const result = await handler.backup(bad)
    expect(result.ok).toBe(false)
    if (result.ok) throw Error('unreachable')
    expect(result.code).toBe('INVALID_REQUEST')
    expect(typeof result.detail).toBe('string')
  }
  expect(runCalled).toBe(false)
})

// ── 3. 🔴 自锁红线组（本任务最重要） ─────────────────────────────────────

it('🔴 自锁红线：maintenanceMain.ts **可执行代码**不含 session.select(...) 调用（防自锁）', () => {
  // 理由（自锁）：`defaultAcquireSpaceLock` 取的路径是 `<root>/.mimir/workspace.writer-lock`，
  // 与 `prepareSelection` 里 `acquireWorkspaceLock(canonical)` 取的**同址同名**。若 backup 前调
  // `select()`，维护会话先持锁，`runSpaceBackup` 再取同一路径必然 `EEXIST` → 每次备份都
  // `LOCK_UNAVAILABLE`（自锁）。故维护会话在 backup 前**只**做 `assertUsable()` 健康检查。
  const raw = readFileSync(join(REPO_ROOT, 'electron/workspaceBackup/maintenanceMain.ts'), 'utf8')
  // 先去注释：本文件的**决策留档 JSDoc** 会以反引号形式提及 `session.select()`（那是文档，
  // 不是调用）；断言必须只针对**可执行代码**，否则文档本身会把用例误判成红。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSDoc）
    .replace(/\/\/[^\n]*/g, '') // 行注释
  expect(code).not.toMatch(/\.select\s*\(/)
  expect(code).not.toMatch(/\.select\s*</)
})

it('🔴 自锁红线：maintenanceBackupHandler.ts **不 import electron**', () => {
  const src = readFileSync(join(REPO_ROOT, 'electron/workspaceBackup/maintenanceBackupHandler.ts'), 'utf8')
  expect(src).not.toMatch(/from\s+['"]electron['"]/)
  expect(src).not.toMatch(/require\(\s*['"]electron['"]\s*\)/)
})

// ── 4. 单向裁剪（结果逐字段透传 + 不含 home） ────────────────────────────

it('backup()：合法请求 → 结果与注入 runBackup 返回值**逐字段相等**（不额外附加 homeDir 等）', async () => {
  const seen: Array<{ spaceId: string; home: string }> = []
  const expected = okResult()
  const handler = buildBackupHandler({
    homeDir: HOME,
    session: { assertUsable: () => { /* 健康 */ } },
    runBackup: async (request, deps) => {
      seen.push({ spaceId: request.spaceId, home: deps.home })
      return expected
    }
  })
  const result = await handler.backup({ spaceId: 'abc' })
  // 逐字段相等（**不**额外附加 `homeDir` / 路径）。
  expect(result).toEqual(expected)
  // 服务层拿到的是规范化后的 spaceId + 注入的 home。
  expect(seen).toEqual([{ spaceId: 'abc', home: HOME }])
  // 关键：序列化结果**不含** home。
  expect(JSON.stringify(result)).not.toContain(HOME)
  expect(JSON.stringify(result)).not.toContain('C:\\')
})

it('backup()：透传 onProgress（进度回调交到服务层 deps）', async () => {
  const events: Array<{ stage: string; detail: string }> = []
  const handler = buildBackupHandler({
    homeDir: HOME,
    session: { assertUsable: () => { /* 健康 */ } },
    onProgress: (p) => { events.push({ stage: p.stage, detail: p.detail }) },
    runBackup: async (_request, deps) => {
      deps.onProgress?.({ stage: 'packing', detail: '正在打包归档…' })
      return okResult()
    }
  })
  await handler.backup({ spaceId: 'abc' })
  expect(events).toEqual([{ stage: 'packing', detail: '正在打包归档…' }])
})

// ── 5. sender 校验 ──────────────────────────────────────────────────────

it('registerBackupHandler：非信任 sender → 抛 UNAUTHORIZED_SENDER（不触发 handler.backup）', () => {
  let backupCalled = false
  const { captured, ipc } = fakeIpc()
  const handler = {
    backup: async (): Promise<MaintenanceBackupResult> => { backupCalled = true; return okResult() }
  }
  registerBackupHandler(ipc, () => false, handler)

  const channels = captured.map((c) => c.channel)
  expect(channels).toContain('workspaceBackup:backupSpace')

  const entry = captured.find((c) => c.channel === 'workspaceBackup:backupSpace')!
  expect(() => entry.listener!({ sender: 'untrusted' }, { spaceId: 'abc' })).toThrowError('UNAUTHORIZED_SENDER')
  expect(backupCalled).toBe(false)
})

it('registerBackupHandler：信任 sender → backup 走规范化（合法放行；多余字段 → INVALID_REQUEST）', async () => {
  const { captured, ipc } = fakeIpc()
  const handler = buildBackupHandler({
    homeDir: HOME,
    session: { assertUsable: () => { /* 健康 */ } },
    runBackup: async () => okResult()
  })
  registerBackupHandler(ipc, () => true, handler)

  const entry = captured.find((c) => c.channel === 'workspaceBackup:backupSpace')!

  const ok = (await entry.listener!({ sender: 'trusted' }, { spaceId: 'abc' })) as MaintenanceBackupResult
  expect(ok.ok).toBe(true)
  if (!ok.ok) throw Error('unreachable')
  expect(ok.archiveName).toBe('mimir-backup-我的空间-20260708-100000.zip')

  const bad = (await entry.listener!({ sender: 'trusted' }, { spaceId: 'abc', path: '/evil' })) as MaintenanceBackupResult
  expect(bad.ok).toBe(false)
  if (bad.ok) throw Error('unreachable')
  expect(bad.code).toBe('INVALID_REQUEST')
})

// ── 6. 异常收敛 + preload 契约文本对齐 ──────────────────────────────────

it('backup()：runBackup 抛异常 → 捕获为 BACKUP_FAILED，**绝不外抛**', async () => {
  const handler = buildBackupHandler({
    homeDir: HOME,
    session: { assertUsable: () => { /* 健康 */ } },
    runBackup: async () => { throw Error('ECONNRESET D:\\secret') }
  })
  // 绝不外抛：用 resolves 断言。
  const result = await handler.backup({ spaceId: 'abc' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('BACKUP_FAILED')
  // detail 是固定脱敏文案，**绝不**回带异常里的绝对路径。
  expect(result.detail).not.toContain('D:\\')
})

it('preload 契约：maintenancePreload.cjs 含两条通道字面量 + 两个方法名（防漂移）', () => {
  const src = readFileSync(join(REPO_ROOT, 'electron/workspaceBackup/maintenancePreload.cjs'), 'utf8')
  // 通道名逐字（与契约 WORKSPACE_BACKUP_CHANNELS 字节一致）。
  expect(src).toContain("'workspaceBackup:backupSpace'")
  expect(src).toContain("'workspaceBackup:backupProgress'")
  // 两个方法名都在。
  expect(src).toContain('backupSpace')
  expect(src).toContain('onBackupProgress')
})
