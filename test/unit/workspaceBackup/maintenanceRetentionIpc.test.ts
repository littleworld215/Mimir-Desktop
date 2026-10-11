import { expect, it } from 'vitest'

import {
  buildRetentionHandler,
  normalizeRetentionToken,
  registerRetentionHandler
} from '../../../electron/workspaceBackup/maintenanceRetentionHandler'
import type {
  MaintenanceRetentionPreview,
  MaintenanceRetentionResult
} from '../../../shared/workspaceBackupContracts'

/**
 * 维护模式「备份保留」IPC 装配（I6 批次 5 · T04）。
 *
 * 目标：**不启动 Electron** 验证装配层的五件事（照 `maintenanceDoctorIpc.test.ts` 范式）：
 * 1. sender 校验（非信任 sender → `UNAUTHORIZED_SENDER`，**两条通道都测**）；
 * 2. 预览端到端（注入假 `buildPreview` → 返回结构正确 + **不含绝对路径**）；
 * 3. `apply` 参数严格校验（合法放行；缺字段 / 非字符串 / 空串 / 超长 / 多余字段 → `INVALID_REQUEST`
 *    且**注入的假 apply 未被调用**，证明早退）；
 * 4. 注入假 `applyRetention` 返回 `TOKEN_MISMATCH` → **如实透出**。
 */

/** 合成 home（形似 Windows 绝对路径，用于裁剪断言）。 */
const HOME = 'C:\\Users\\科研\\AppData\\Roaming\\mimir-home'
/** 形似本机绝对路径的样本（**不得**出现在预览结果里）。 */
const ABS = 'D:\\科研\\我的空间\\backups\\mimir-backup-space-20260708-100000.zip'

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

/** 一份含「疑似路径」的假预览（验证服务层裁剪 + 本层不额外带出 home）。 */
function fakePreview(): MaintenanceRetentionPreview {
  return {
    ok: true,
    items: [
      { name: 'mimir-backup-space-20260708-100000.zip', bytes: 1024, modifiedAt: '2026-07-08T10:00:00.000Z', disposition: 'keep', reason: 'recent' },
      { name: 'mimir-backup-space-20260601-090000.zip', bytes: 2048, modifiedAt: '2026-06-01T09:00:00.000Z', disposition: 'remove', reason: 'beyond-keep' }
    ],
    reclaimableBytes: 2048,
    confirmToken: 'tok-abc',
    keepPolicy: 20
  }
}

// ── 1. 参数规范化（纯函数，严格） ───────────────────────────────────────

it('normalizeRetentionToken：合法 { confirmToken } → 通过', () => {
  expect(normalizeRetentionToken({ confirmToken: 'abc' })).toEqual({ ok: true, token: 'abc' })
})

it('normalizeRetentionToken：缺字段 / 非字符串 / 空串 / 超长 / 多余字段 / 非对象 → 一律拒绝', () => {
  // 缺字段。
  expect(normalizeRetentionToken({}).ok).toBe(false)
  // 非字符串。
  expect(normalizeRetentionToken({ confirmToken: 123 }).ok).toBe(false)
  // 空串。
  expect(normalizeRetentionToken({ confirmToken: '' }).ok).toBe(false)
  // 超长（> 512）。
  expect(normalizeRetentionToken({ confirmToken: 'x'.repeat(513) }).ok).toBe(false)
  // 边界：恰好 512 合法。
  expect(normalizeRetentionToken({ confirmToken: 'x'.repeat(512) }).ok).toBe(true)
  // 多余字段（**关键**：任何多余字段一律拒绝）。
  expect(normalizeRetentionToken({ confirmToken: 'abc', path: ABS }).ok).toBe(false)
  expect(normalizeRetentionToken({ confirmToken: 'abc', files: ['a'] }).ok).toBe(false)
  // 非对象。
  expect(normalizeRetentionToken(null).ok).toBe(false)
  expect(normalizeRetentionToken(undefined).ok).toBe(false)
  expect(normalizeRetentionToken('abc').ok).toBe(false)
  expect(normalizeRetentionToken(['abc']).ok).toBe(false)
})

// ── 2. 预览端到端 + 裁剪纪律 ────────────────────────────────────────────

it('preview()：注入假 buildPreview → 返回结构正确；**不含** home / 绝对路径', async () => {
  const seen: Array<{ home: string }> = []
  const handler = buildRetentionHandler({
    homeDir: HOME,
    buildPreview: (deps) => { seen.push(deps); return fakePreview() }
  })
  const result = await handler.preview()
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result.items).toHaveLength(2)
  expect(result.reclaimableBytes).toBe(2048)
  expect(result.confirmToken).toBe('tok-abc')
  expect(result.keepPolicy).toBe(20)
  // 入参 home 被透传给服务层（生产 = homedir()）。
  expect(seen).toEqual([{ home: HOME }])
  // 关键：结果里**不含**任何本机绝对路径 / home。
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain(HOME)
  expect(serialized).not.toContain('D:\\')
  expect(serialized).not.toContain('C:\\')
  // items[].name 是 basename，不含分隔符。
  for (const item of result.items) {
    expect(item.name).not.toContain('\\')
    expect(item.name).not.toContain('/')
  }
})

it('preview()：缺省 buildPreview 走真服务层（只读，空 home → ok，items 为空）', async () => {
  // 用不存在目录的合成 home：真 `listManagedArchives` 遇到缺目录返回 `[]`（只读，不建目录）。
  const handler = buildRetentionHandler({ homeDir: `${HOME}\\__does_not_exist__` })
  const result = await handler.preview()
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result.items).toEqual([])
  expect(result.reclaimableBytes).toBe(0)
})

// ── 3. apply 参数严格校验 + 早退 ────────────────────────────────────────

it('apply()：合法 { confirmToken } → 走真逻辑（注入假 apply，透传规范化后的 token + home）', async () => {
  const seen: Array<{ token: string; home: string }> = []
  const handler = buildRetentionHandler({
    homeDir: HOME,
    applyRetention: (token, deps) => { seen.push({ token, home: deps.home }); return { ok: true, removed: 1, failed: 0, reclaimedBytes: 1024 } }
  })
  const result = await handler.apply({ confirmToken: 'abc' })
  expect(result).toEqual({ ok: true, removed: 1, failed: 0, reclaimedBytes: 1024 })
  expect(seen).toEqual([{ token: 'abc', home: HOME }])
})

it('apply()：非法入参 → INVALID_REQUEST，且**注入的假 apply 未被调用**（早退零副作用）', async () => {
  let applyCalled = false
  const handler = buildRetentionHandler({
    homeDir: HOME,
    applyRetention: () => { applyCalled = true; return { ok: true, removed: 0, failed: 0, reclaimedBytes: 0 } }
  })

  const badInputs: unknown[] = [
    {},
    { confirmToken: 123 },
    { confirmToken: '' },
    { confirmToken: 'x'.repeat(513) },
    { confirmToken: 'abc', path: ABS },
    { confirmToken: 'abc', files: ['x'] },
    null,
    undefined,
    'plain-string',
    ['abc'],
    { token: 'abc' } // 字段名写错（只有 confirmToken 才认）
  ]

  for (const bad of badInputs) {
    const result = await handler.apply(bad)
    expect(result.ok).toBe(false)
    if (result.ok) throw Error('unreachable')
    expect(result.code).toBe('INVALID_REQUEST')
    expect(typeof result.detail).toBe('string')
  }
  // **关键**：一次都没有触达服务层（证明是早退，而非调用后失败）。
  expect(applyCalled).toBe(false)
})

// ── 4. 结果如实透出 ─────────────────────────────────────────────────────

it('apply()：注入假 applyRetention 返回 TOKEN_MISMATCH → 如实透出', async () => {
  const handler = buildRetentionHandler({
    homeDir: HOME,
    applyRetention: () => ({ ok: false, code: 'TOKEN_MISMATCH', detail: '候选集已变化。' })
  })
  const result = await handler.apply({ confirmToken: 'stale' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('TOKEN_MISMATCH')
  expect(result.detail).toBe('候选集已变化。')
})

it('apply()：注入假 applyRetention 返回部分失败（failed>0）→ 如实上报，不掩盖', async () => {
  const handler = buildRetentionHandler({
    homeDir: HOME,
    applyRetention: () => ({ ok: true, removed: 2, failed: 1, reclaimedBytes: 3072 })
  })
  const result = await handler.apply({ confirmToken: 'abc' })
  expect(result).toEqual({ ok: true, removed: 2, failed: 1, reclaimedBytes: 3072 })
})

// ── 5. sender 校验（两条通道都测） ─────────────────────────────────────

it('registerRetentionHandler：非信任 sender → 抛 UNAUTHORIZED_SENDER（两条通道；不触发 preview/apply）', () => {
  let previewCalled = false
  let applyCalled = false
  const { captured, ipc } = fakeIpc()
  const handler = {
    preview: async () => { previewCalled = true; return fakePreview() },
    apply: async (): Promise<MaintenanceRetentionResult> => { applyCalled = true; return { ok: true, removed: 0, failed: 0, reclaimedBytes: 0 } }
  }
  registerRetentionHandler(ipc, () => false, handler)

  // 通道名逐个确认（不硬编码，与契约常量一致）。
  const channels = captured.map((c) => c.channel)
  expect(channels).toContain('workspaceBackup:retentionPreview')
  expect(channels).toContain('workspaceBackup:retentionApply')

  const previewEntry = captured.find((c) => c.channel === 'workspaceBackup:retentionPreview')!
  const applyEntry = captured.find((c) => c.channel === 'workspaceBackup:retentionApply')!
  expect(() => previewEntry.listener!({ sender: 'untrusted' })).toThrowError('UNAUTHORIZED_SENDER')
  expect(() => applyEntry.listener!({ sender: 'untrusted' }, { confirmToken: 'abc' })).toThrowError('UNAUTHORIZED_SENDER')
  expect(previewCalled).toBe(false)
  expect(applyCalled).toBe(false)
})

it('registerRetentionHandler：信任 sender → preview 正常返回；apply 走规范化（缺字段 → INVALID_REQUEST）', async () => {
  const { captured, ipc } = fakeIpc()
  const handler = buildRetentionHandler({
    homeDir: HOME,
    buildPreview: () => fakePreview(),
    applyRetention: () => ({ ok: true, removed: 1, failed: 0, reclaimedBytes: 1024 })
  })
  registerRetentionHandler(ipc, () => true, handler)

  const previewEntry = captured.find((c) => c.channel === 'workspaceBackup:retentionPreview')!
  const applyEntry = captured.find((c) => c.channel === 'workspaceBackup:retentionApply')!

  const preview = (await previewEntry.listener!({ sender: 'trusted' })) as MaintenanceRetentionPreview
  expect(preview).toMatchObject({ ok: true, confirmToken: 'tok-abc' })

  // 合法入参 → 走真逻辑。
  const ok = (await applyEntry.listener!({ sender: 'trusted' }, { confirmToken: 'abc' })) as MaintenanceRetentionResult
  expect(ok).toEqual({ ok: true, removed: 1, failed: 0, reclaimedBytes: 1024 })

  // 非法入参（多余字段）→ INVALID_REQUEST。
  const bad = (await applyEntry.listener!({ sender: 'trusted' }, { confirmToken: 'abc', extra: 1 })) as MaintenanceRetentionResult
  expect(bad.ok).toBe(false)
  if (bad.ok) throw Error('unreachable')
  expect(bad.code).toBe('INVALID_REQUEST')
})
