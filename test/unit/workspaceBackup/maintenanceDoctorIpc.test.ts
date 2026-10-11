import { expect, it } from 'vitest'

import {
  buildDoctorHandler,
  registerDoctorHandler,
  toDoctorResult
} from '../../../electron/workspaceBackup/maintenanceDoctorHandler'
import type {
  DoctorReport,
  MaintenanceAuditEntry,
  MaintenanceAuditView
} from '../../../shared/workspaceBackupContracts'

/**
 * 维护模式自检 / 审计 IPC 装配（I6 批次 4 · T04）。
 *
 * 目标：**不启动 Electron** 验证装配层的四件事（照 `maintenanceRestoreIpc.test.ts:287-328` 范式）：
 * 1. sender 校验（非信任 sender → `UNAUTHORIZED_SENDER`）；
 * 2. 只读端到端（注入假 `buildReport` → 返回结构正确）；
 * 3. 裁剪纪律（`toDoctorResult` 结果**不含** home / 暂存根路径 / 绝对路径）；
 * 4. 审计旁路语义（`writeAudit` 抛错时 `doctor()` **仍返回成功**）。
 */

/** 合成 home（形似 Windows 绝对路径，用于裁剪断言）。 */
const HOME = 'C:\\Users\\科研\\AppData\\Roaming\\mimir-home'
/** 形似本机绝对路径的样本（**不得**出现在裁剪结果里）。 */
const ABS = 'D:\\科研\\我的空间\\papers\\a.pdf'

/** 一份含「疑似路径」的假自检报告（验证裁剪 + 白名单重建不泄漏）。 */
function fakeReport(): DoctorReport & { internalPath?: string } {
  return {
    at: '2026-07-08T10:00:00.000Z',
    checks: [
      { id: 'REGISTRY_READABLE', title: '注册表可读', severity: 'ok', detail: '本机注册表可读，共登记 2 个空间。', facts: { spaces: 2 } },
      { id: 'ARCHIVE_VERIFY', title: '归档验包', severity: 'warning', detail: `归档 a.pdf（SHA_MISMATCH）未通过。`, facts: { total: 3, verified: 2, failed: 1 } },
      { id: 'RESIDUAL_ARTIFACTS', title: '残留暂存根', severity: 'notice', detail: '发现 1 个残留暂存根（不自动清理）。', facts: { found: 1 } }
    ],
    summary: { ok: 1, notice: 1, warning: 1, error: 0 },
    // 上游若误挂内部字段，白名单重建必须把它剥掉。
    internalPath: ABS
  } as DoctorReport & { internalPath?: string }
}

/** 假 ipc：捕获注册用的 listener（照既有范式）。 */
function fakeIpc(): { captured: { channel?: string; listener?: (event: unknown, ...args: unknown[]) => unknown }[]; ipc: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void } } {
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

// ── 1. 裁剪纪律（**绝不**泄漏本机路径） ─────────────────────────────────

it('toDoctorResult：成功 → {ok:true, at, checks, summary}；**不含** home / 暂存根 / 绝对路径', () => {
  const result = toDoctorResult(fakeReport())
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result.at).toBe('2026-07-08T10:00:00.000Z')
  expect(result.checks).toHaveLength(3)
  expect(result.summary).toEqual({ ok: 1, notice: 1, warning: 1, error: 0 })
  // 白名单重建：内部字段不得外泄。
  expect('internalPath' in result).toBe(false)
  for (const check of result.checks) {
    expect(Object.keys(check).every((k) => ['id', 'title', 'severity', 'detail', 'facts'].includes(k))).toBe(true)
  }
  // 关键：结果里**不含**任何本机绝对路径 / home / 暂存根标识。
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain(ABS)
  expect(serialized).not.toContain(HOME)
  expect(serialized).not.toContain('D:\\')
  expect(serialized).not.toContain('.mimir-restore-staging')
})

it('toDoctorResult：即便 checks[].detail 混入绝对路径片段……（上游已脱敏；此处断言白名单字段不被替换）', () => {
  // 模拟「上游 detail 未脱敏」这一不该发生的场景：本层不做二次脱敏（脱敏只在 buildDoctorReport
  // 一处实现），但断言白名单重建只保留契约字段，不额外携带内部结构。
  const report: DoctorReport = {
    at: 't',
    checks: [{ id: 'X', title: 't', severity: 'ok', detail: '明文', facts: { n: 1 } }],
    summary: { ok: 1, notice: 0, warning: 0, error: 0 }
  }
  const result = toDoctorResult(report)
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result.checks[0]).toEqual({ id: 'X', title: 't', severity: 'ok', detail: '明文', facts: { n: 1 } })
})

// ── 2. 只读端到端 + 审计留痕 ────────────────────────────────────────────

it('doctor()：注入假 buildReport → 返回裁剪结果；审计被写入（entry 无路径）', async () => {
  const written: Array<{ home: string; entry: MaintenanceAuditEntry }> = []
  const handler = buildDoctorHandler({
    homeDir: HOME,
    buildReport: async () => fakeReport(),
    writeAudit: (home, entry) => { written.push({ home, entry }) }
  })
  const result = await handler.doctor()
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result.summary.warning).toBe(1)
  // 审计被写入一次，action='doctor'、outcome='ok'，且 entry 里**不含**任何路径。
  expect(written).toHaveLength(1)
  expect(written[0]!.home).toBe(HOME)
  expect(written[0]!.entry.action).toBe('doctor')
  expect(written[0]!.entry.outcome).toBe('ok')
  expect(written[0]!.entry.counts).toMatchObject({ checks: 3, ok: 1, warning: 1 })
  const serializedEntry = JSON.stringify(written[0]!.entry)
  expect(serializedEntry).not.toContain(ABS)
  expect(serializedEntry).not.toContain(HOME)
  expect(serializedEntry).not.toContain('D:\\')
})

it('doctor()：writeAudit 注入会抛错的实现 → doctor() **仍返回成功**（审计失败不影响主流程）', async () => {
  let threw = false
  const handler = buildDoctorHandler({
    homeDir: HOME,
    buildReport: async () => fakeReport(),
    writeAudit: () => { threw = true; throw Error('磁盘满 / 权限错') }
  })
  const result = await handler.doctor()
  expect(threw).toBe(true)
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result.checks).toHaveLength(3)
})

it('doctor()：onProgress 被透传给 buildReport', async () => {
  const seen: string[] = []
  const handler = buildDoctorHandler({
    homeDir: HOME,
    onProgress: (p) => { seen.push(p.stage) },
    buildReport: async (_deps) => { _deps.onProgress?.({ stage: 'doctor', detail: '正在检查注册表…' }); return fakeReport() },
    writeAudit: () => {}
  })
  await handler.doctor()
  expect(seen).toEqual(['doctor'])
})

// ── 3. auditRecent 只读 ──────────────────────────────────────────────────

it('auditRecent(limit)：走假 readAudit，透传 home/limit，返回已脱敏视图', async () => {
  const view: MaintenanceAuditView = {
    entries: [{ at: 't', action: 'restore', outcome: 'ok', counts: { entries: 7 } }],
    skipped: 0
  }
  const calls: Array<{ home: string; limit?: number }> = []
  const handler = buildDoctorHandler({
    homeDir: HOME,
    readAudit: (home, limit) => { calls.push({ home, limit }); return view }
  })
  const result = await handler.auditRecent(10)
  expect(calls).toEqual([{ home: HOME, limit: 10 }])
  expect(result).toEqual(view)
  // 视图里**不含** JSONL 文件路径。
  expect(JSON.stringify(result)).not.toContain('.jsonl')
  expect(JSON.stringify(result)).not.toContain(HOME)
})

// ── 4. sender 校验（照既有范式） ────────────────────────────────────────

it('registerDoctorHandler：非信任 sender → 抛 UNAUTHORIZED_SENDER（不触发自检/读审计）', () => {
  let doctorCalled = false
  let auditCalled = false
  const { captured, ipc } = fakeIpc()
  const handler = {
    doctor: async () => { doctorCalled = true; return toDoctorResult(fakeReport()) },
    auditRecent: async () => { auditCalled = true; return { entries: [], skipped: 0 } }
  }
  registerDoctorHandler(ipc, () => false, handler)

  // 通道名逐个确认（不硬编码，与契约常量一致）。
  const channels = captured.map((c) => c.channel)
  expect(channels).toContain('workspaceBackup:doctor')
  expect(channels).toContain('workspaceBackup:auditRecent')

  const doctorEntry = captured.find((c) => c.channel === 'workspaceBackup:doctor')!
  const auditEntry = captured.find((c) => c.channel === 'workspaceBackup:auditRecent')!
  expect(() => doctorEntry.listener!({ sender: 'untrusted' })).toThrowError('UNAUTHORIZED_SENDER')
  expect(() => auditEntry.listener!({ sender: 'untrusted' }, 5)).toThrowError('UNAUTHORIZED_SENDER')
  expect(doctorCalled).toBe(false)
  expect(auditCalled).toBe(false)
})

it('registerDoctorHandler：信任 sender → doctor 正常返回裁剪结果', async () => {
  const { captured, ipc } = fakeIpc()
  const handler = buildDoctorHandler({
    homeDir: HOME,
    buildReport: async () => fakeReport(),
    writeAudit: () => {}
  })
  registerDoctorHandler(ipc, () => true, handler)
  const doctorEntry = captured.find((c) => c.channel === 'workspaceBackup:doctor')!
  const result = (await doctorEntry.listener!({ sender: 'trusted' })) as { ok: boolean }
  expect(result).toMatchObject({ ok: true })
})

it('registerDoctorHandler：auditRecent 的非法 limit（非数字）被收窄为 undefined → 走默认', async () => {
  const { captured, ipc } = fakeIpc()
  let seenLimit: number | undefined | 'unset' = 'unset'
  const handler = buildDoctorHandler({
    homeDir: HOME,
    readAudit: (_home, limit) => { seenLimit = limit; return { entries: [], skipped: 0 } }
  })
  registerDoctorHandler(ipc, () => true, handler)
  const auditEntry = captured.find((c) => c.channel === 'workspaceBackup:auditRecent')!
  await (auditEntry.listener!({ sender: 'trusted' }, 'not-a-number') as Promise<unknown>)
  expect(seenLimit).toBeUndefined()
})
