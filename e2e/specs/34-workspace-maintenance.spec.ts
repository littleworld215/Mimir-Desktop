import { expect, test } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { launchApp, mainEntry, repoRoot } from '../fixtures/launch'

test('维护启动只暴露专用只读桥，不装载日常业务与源库', async () => {
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'I6维护首版限Windows x64')
  const ctx = await launchApp({ extraArgs: ['--workspace-maintenance'], transformSeed: seed => ({ ...seed, spaceData: { unknown: { original: '保留资料' } } }) })
  try {
    const bridge = await ctx.page.evaluate(() => ({ ordinary: typeof (window as any).electronAPI, maintenance: typeof (window as any).workspaceBackupMaintenance }))
    expect(bridge).toEqual({ ordinary: 'undefined', maintenance: 'object' })
    const channels = await ctx.app.evaluate(({ ipcMain }) => Array.from((ipcMain as any)._invokeHandlers.keys()))
    expect(channels).toEqual(['workspaceBackup:overview'])
    await expect(ctx.page.getByRole('heading', { name: '备份与恢复维护窗口' })).toBeVisible()
    const overview = await ctx.page.evaluate(() => (window as any).workspaceBackupMaintenance.overview())
    expect(overview.ok).toBe(true)
    expect(overview.spaces).toHaveLength(1)
    expect(Object.keys(overview.spaces[0]).sort()).toEqual(['id', 'name'])
    const global = JSON.parse(readFileSync(join(ctx.tempHome.home, '.mimir/store.json'), 'utf8'))
    const root = global['workspaces:list'][0].path
    expect(JSON.parse(readFileSync(join(root, '.mimir/store.json'), 'utf8'))).toEqual({ unknown: { original: '保留资料' } })
    expect(existsSync(join(root, '.mimir/assets/assets.db'))).toBe(false)
    expect(existsSync(join(root, '.mimir/workspace.writer-lock'))).toBe(false)
    expect(existsSync(join(ctx.tempHome.home, '.mimir/registry.writer-lock'))).toBe(true)
  } finally {
    try {
      await ctx.app.close()
      expect(existsSync(join(ctx.tempHome.home, '.mimir/registry.writer-lock'))).toBe(false)
    } finally { await ctx.cleanup() }
  }
})

for (const maintenanceOwner of [true, false]) {
  test(`同profile互斥：${maintenanceOwner ? '维护' : '普通'}实例阻止另一入口`, async () => {
    test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'I6维护首版限Windows x64')
    const ctx = await launchApp({ extraArgs: maintenanceOwner ? ['--workspace-maintenance'] : [] })
    let second: ReturnType<typeof spawn> | undefined
    try {
      await ctx.app.evaluate(({ app }) => {
        ;(globalThis as any).__maintenanceSecondInstance = false
        app.once('second-instance', () => { (globalThis as any).__maintenanceSecondInstance = true })
      })
      const executable = await ctx.app.evaluate(() => process.execPath)
      second = spawn(executable, [mainEntry, ...(!maintenanceOwner ? ['--workspace-maintenance'] : []), `--user-data-dir=${ctx.tempHome.userData}`], {
        cwd: repoRoot, stdio: 'ignore', env: { ...process.env, HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home,
          MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' }
      })
      const child = second
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error('SECOND_INSTANCE_TIMEOUT')) }, 15_000)
        child.once('exit', code => { clearTimeout(timer); resolve(code) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
      })
      expect(exit).toBe(0)
      await expect.poll(() => ctx.app.evaluate(() => (globalThis as any).__maintenanceSecondInstance)).toBe(true)
      expect(ctx.app.windows()).toHaveLength(1)
    } finally {
      if (second && second.exitCode === null) second.kill()
      await ctx.cleanup()
    }
  })
}
