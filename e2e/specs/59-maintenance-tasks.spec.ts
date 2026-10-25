import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchApp, type LaunchedApp } from '../fixtures/launch'
import { createBackup } from '../../electron/workspaceBackup/packer'
import type { MaintenanceRestoreResult } from '../../shared/workspaceBackupContracts'

const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
async function prepare(large = false) {
  let source = '', spaceId = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, extraArgs: ['--workspace-maintenance'], transformSeed: seed => {
    source = seed.workspaces[0].path; spaceId = seed.workspaces[0].id; return seed
  } })
  writeFileSync(join(source, '合成资料.bin'), large ? Buffer.alloc(64 * 1024 * 1024, 71) : '合成资料')
  const archive = join(ctx.tempHome.home, 'backups/g06.zip'), targetRoot = join(dirname(source), 'G06恢复')
  mkdirSync(dirname(archive), { recursive: true })
  await createBackup({ root: source, destination: archive, stagingDir: join(ctx.tempHome.root, 'packing'), assetsDb: null, sourceSpaceId: spaceId })
  return { ctx, source, spaceId, archive, targetRoot, before: digest(archive), registry: join(ctx.tempHome.home, '.mimir/store.json') }
}
async function nativeChoice(ctx: LaunchedApp, archive: string, target: string) {
  // 仅当前隔离实例的原生UI桩；产品没有测试路径或批准后门。
  expect(archive.startsWith(ctx.tempHome.root)).toBe(true)
  expect(target.startsWith(ctx.tempHome.root)).toBe(true)
  await ctx.app.evaluate(({ dialog }, choice) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choice.archive] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: choice.target })
  }, { archive, target })
}
test('原生选择取消不执行渲染层文本路径，匿名取消被拒绝', async () => {
  const f = await prepare()
  try {
    const before = readFileSync(f.registry)
    const result = await f.ctx.page.evaluate(async request => {
      const api = window.workspaceBackupMaintenance
      const anonymous = await api.cancelRestore!()
      const restore = await api.restore!(request)
      return { anonymous, restore }
    }, { archivePath: f.archive, targetRoot: f.targetRoot, spaceName: 'G06' })
    expect(result).toMatchObject({ anonymous: { ok: false, code: 'INVALID_REQUEST' }, restore: { ok: false, code: 'CANCELLED' } })
    expect(existsSync(f.targetRoot)).toBe(false)
    expect(readFileSync(f.registry)).toEqual(before)
    expect(digest(f.archive)).toBe(f.before)
  } finally { await f.ctx.cleanup() }
})
test('执行位置只来自原生选择，文本建议不会授予复制权限', async () => {
  const f = await prepare()
  try {
    await nativeChoice(f.ctx, f.archive, f.targetRoot)
    const suggested = join(f.ctx.tempHome.root, 'forged-target')
    const result = await f.ctx.page.evaluate(request => window.workspaceBackupMaintenance.restore!(request), {
      archivePath: join(f.ctx.tempHome.root, 'forged.zip'), targetRoot: suggested, spaceName: 'G06原生结果'
    })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, root: f.targetRoot })
    expect(existsSync(suggested)).toBe(false)
    expect(readFileSync(join(f.targetRoot, '合成资料.bin'))).toEqual(readFileSync(join(f.source, '合成资料.bin')))
    expect(digest(f.archive)).toBe(f.before)
  } finally { await f.ctx.cleanup() }
})
test('真实界面取消备份等待资源收尾，不发布正式归档', async () => {
  const f = await prepare(true)
  try {
    await f.ctx.page.evaluate(() => {
      window.workspaceBackupMaintenance.onBackupProgress!(p => { if (p.taskId) (window as unknown as { g06TaskId: string }).g06TaskId = p.taskId })
    })
    await f.ctx.page.getByRole('button', { name: '备份该空间', exact: true }).click()
    const cancel = f.ctx.page.getByRole('button', { name: '取消备份', exact: true })
    await expect(cancel).toBeEnabled()
    await cancel.click()
    await expect(f.ctx.page.getByRole('alert').filter({ hasText: '维护任务已在安全点停止。' })).toBeVisible()
    expect(await f.ctx.page.evaluate(() => window.workspaceBackupMaintenance.taskStatus!({ taskId: (window as unknown as { g06TaskId: string }).g06TaskId }))).toMatchObject({ ok: true, task: { state: 'cancelled' } })
    await expect(f.ctx.page.getByRole('button', { name: '备份该空间', exact: true })).toBeEnabled()
    expect(readdirSync(dirname(f.archive)).filter(name => name.endsWith('.zip'))).toEqual(['g06.zip'])
    const stage = join(dirname(f.archive), '.staging')
    expect(!existsSync(stage) || readdirSync(stage).length === 0).toBe(true)
    expect(existsSync(join(f.source, '.mimir/workspace.writer-lock'))).toBe(false)
    expect(digest(f.archive)).toBe(f.before)
  } finally { await f.ctx.cleanup() }
})
test('真实恢复在发布前接受指定任务取消，不登记新空间', async () => {
  const f = await prepare(true)
  try {
    await nativeChoice(f.ctx, f.archive, f.targetRoot)
    const before = readFileSync(f.registry)
    const result = await f.ctx.page.evaluate(async request => {
      const api = window.workspaceBackupMaintenance
      let cancellation: Promise<unknown> | undefined
      const off = api.onRestoreProgress!(progress => {
        if (progress.stage === 'extracting' && progress.taskId && !cancellation) cancellation = api.cancelTask!({ taskId: progress.taskId })
      })
      try { const outcome = await api.restore!(request); return { outcome, cancelled: await cancellation } }
      finally { off() }
    }, { archivePath: f.archive, targetRoot: f.targetRoot, spaceName: 'G06取消' })
    expect(result).toMatchObject({ outcome: { ok: false, code: 'CANCELLED' }, cancelled: { ok: true } })
    expect(existsSync(f.targetRoot)).toBe(false)
    expect(readFileSync(f.registry)).toEqual(before)
    expect(digest(f.archive)).toBe(f.before)
  } finally { await f.ctx.cleanup() }
})
test('真实自检取消保留原包且不写成功审计', async () => {
  const f = await prepare(true)
  try {
    const result = await f.ctx.page.evaluate(async () => {
      const api = window.workspaceBackupMaintenance
      const before = await api.auditRecent!()
      let cancelled: Promise<unknown> | undefined
      const off = api.onDoctorProgress!(progress => {
        if (progress.stage === 'doctor' && progress.taskId && !cancelled) cancelled = api.cancelTask!({ taskId: progress.taskId })
      })
      try { const outcome = await api.doctor!(); return { outcome, cancelled: await cancelled, before, after: await api.auditRecent!() } }
      finally { off() }
    })
    expect(result).toMatchObject({ outcome: { ok: false, code: 'CANCELLED' }, cancelled: { ok: true } })
    expect(result.after).toEqual(result.before)
    expect(digest(f.archive)).toBe(f.before)
  } finally { await f.ctx.cleanup() }
})
test('旧任务取消不能影响新任务，状态接口不返回原始路径', async () => {
  const f = await prepare(true)
  try {
    const result = await f.ctx.page.evaluate(async spaceId => {
      const api = window.workspaceBackupMaintenance
      let oldId = ''
      const offDoctor = api.onDoctorProgress!(p => { if (p.taskId) oldId = p.taskId })
      await api.doctor!(); offDoctor()
      let oldCancel: unknown, currentCancel: unknown, status: unknown
      const off = api.onBackupProgress!(p => {
        if (p.stage === 'starting' && p.taskId) void (async () => {
          oldCancel = await api.cancelTask!({ taskId: oldId })
          status = await api.taskStatus!({ taskId: p.taskId! })
          currentCancel = await api.cancelTask!({ taskId: p.taskId! })
        })()
      })
      try { const outcome = await api.backupSpace!({ spaceId }); return { outcome, oldCancel, currentCancel, status } }
      finally { off() }
    }, f.spaceId)
    expect(result).toMatchObject({ outcome: { ok: false, code: 'CANCELLED' }, oldCancel: { ok: false, code: 'STALE_TASK' }, currentCancel: { ok: true }, status: { ok: true, task: { kind: 'backup', state: 'running' } } })
    expect(JSON.stringify(result.status)).not.toContain(f.ctx.tempHome.root)
  } finally { await f.ctx.cleanup() }
})
