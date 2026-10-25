import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'

test('真实维护备份：写临时包期间新增来源，拒绝发布且原资料保留', async () => {
  let sourceRoot = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED,
    maintenanceRestoreSuggestions: true, extraArgs: ['--workspace-maintenance'],
    transformSeed: seed => { sourceRoot = seed.workspaces[0].path; return seed }
  })
  try {
    mkdirSync(sourceRoot, { recursive: true })
    const original = join(sourceRoot, '原资料.txt')
    writeFileSync(original, '合成资料不得被备份写入')
    // 不可压缩合成文件保证能观察到实际写包阶段，不依赖固定sleep或修改产品测试钩子。
    writeFileSync(join(sourceRoot, 'synthetic.bin'), randomBytes(32 * 1024 * 1024))
    const staging = join(ctx.tempHome.home, 'backups', '.staging')
    let ended = false
    const backup = ctx.page.evaluate(async () => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
      const overview = await api.overview()
      if (!overview.ok || !api.backupSpace) throw Error('Missing backup entry')
      return api.backupSpace({ spaceId: overview.spaces[0].id })
    }).finally(() => { ended = true })
    // 同时观察拒绝，测试定位失败时不留下未处理Promise。
    void backup.catch(() => {})
    await expect.poll(() => {
      const partial = existsSync(staging) && readdirSync(staging).some(name => name.endsWith('.zip.partial'))
      if (ended && !partial) throw Error('Backup ended before the partial archive was observed')
      return Boolean(partial)
    }, { timeout: 30_000, intervals: [5, 10, 20] }).toBe(true)
    writeFileSync(join(sourceRoot, 'late.txt'), '清单后新增的合成资料')
    const result = await backup
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false })
    const overview = await ctx.page.evaluate(() =>
      (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance.overview())
    expect(overview.ok && overview.archives).toEqual([])
    expect(readdirSync(staging)).toEqual([])
    expect(readFileSync(original, 'utf8')).toBe('合成资料不得被备份写入')
    expect(readFileSync(join(sourceRoot, 'late.txt'), 'utf8')).toBe('清单后新增的合成资料')
  } finally { await ctx.cleanup() }
})
