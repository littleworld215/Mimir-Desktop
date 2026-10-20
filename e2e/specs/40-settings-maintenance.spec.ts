import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { launchApp, mainEntry } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

test('设置未保存时禁止进入维护，取消确认不关闭工作台', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    const { page } = ctx
    await gotoModule(page, 'settings')
    await page.getByRole('main').getByRole('button', { name: '科研空间', exact: true }).click()
    const entry = page.getByRole('button', { name: '备份与恢复', exact: true })
    await expect(entry).toBeEnabled()
    await entry.click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await page.getByRole('button', { name: '深色', exact: true }).click()
    await page.getByRole('main').getByRole('button', { name: '科研空间', exact: true }).click()
    await expect(entry).toBeDisabled()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(entry).toBeEnabled()
  } finally { await ctx.cleanup() }
})

test('取消原生关闭可再次进入；交接完成时写锁已释放且没有并行普通退出', async ({}, testInfo) => {
  const executablePath = process.env.MIMIR_E2E_PACKAGED
  const ctx = await launchApp({ executablePath })
  let primaryFailure: unknown
  let maintenance: ElectronApplication | undefined
  try {
    const { page, app } = ctx
    // 仅替换最终进程重启/退出，真实关闭守卫、任务排空和释放锁照常执行。
    await app.evaluate(({ app, dialog, net }) => {
      const actualFetch = net.fetch.bind(net)
      net.fetch = (input, init) => String(input) === 'https://ccfddl.github.io/conference/allconf.yml'
        ? Promise.resolve(new Response('- title: SYNTHETIC\n  confs:\n    - id: s2026\n      year: 2026\n')) : actualFetch(input, init)
      const state = { relaunches: 0, exitCodes: [] as number[], locksReleased: false, modeArgsCorrect: false }
      const write = () => process.getBuiltinModule('fs').writeFileSync(process.getBuiltinModule('path').join(app.getPath('userData'), 'maintenance-probe.json'), JSON.stringify(state))
      ;(globalThis as any).__maintenanceProbe = state
      app.relaunch = options => {
        const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path'), os = process.getBuiltinModule('os')
        const home = os.homedir(), registry = JSON.parse(fs.readFileSync(path.join(home, '.mimir/store.json'), 'utf8'))
        state.locksReleased = !fs.existsSync(path.join(home, '.mimir/registry.writer-lock')) && registry['workspaces:list'].every((s: { path: string }) => !fs.existsSync(path.join(s.path, '.mimir/workspace.writer-lock')))
        state.relaunches++
        state.modeArgsCorrect = Boolean(options?.args?.includes('--workspace-maintenance') && !options.args.includes('--assets-mcp'))
        write()
      }
      app.exit = code => { state.exitCodes.push(code ?? 0); write() }
      dialog.showMessageBoxSync = () => 0
      dialog.showErrorBox = () => { console.error('Synthetic maintenance handoff failed') }
    })
    await expect.poll(() => existsSync(join(ctx.tempHome.home, 'Mimir/科研空间/.mimir/venue-deadlines.cache.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(ctx.tempHome.home, 'Mimir/科研空间/.mimir/venue-deadlines.cache.json'), 'utf8')).venues[0].title).toBe('SYNTHETIC')
    await gotoModule(page, 'settings')
    await page.getByRole('main').getByRole('button', { name: '科研空间', exact: true }).click()
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    await page.evaluate(() => {
      const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
      ;(window as any).__maintenanceGuard = guard
      window.addEventListener('beforeunload', guard)
    })
    await page.getByRole('button', { name: '关闭工作台并进入维护', exact: true }).click()
    await expect(page.getByText(/已请求进入维护/)).toBeVisible()
    expect((await app.evaluate(() => (globalThis as any).__maintenanceProbe)).relaunches).toBe(0)
    await page.evaluate(() => window.removeEventListener('beforeunload', (window as any).__maintenanceGuard))
    await page.getByRole('button', { name: '关闭工作台并进入维护', exact: true }).click()
    const probe = join(ctx.tempHome.userData, 'maintenance-probe.json')
    await expect.poll(() => existsSync(probe) ? JSON.parse(readFileSync(probe, 'utf8')) : null, { timeout: 15_000 }).toEqual({ relaunches: 1, exitCodes: [0], locksReleased: true, modeArgsCorrect: true })
    await app.close()
    // 最终启动由测试进程接管，以继续核对同一隔离profile的真实维护IPC。
    maintenance = await electron.launch({ executablePath, args: [...(executablePath ? [] : [mainEntry]), '--workspace-maintenance', `--user-data-dir=${ctx.tempHome.userData}`], cwd: ctx.tempHome.root,
      env: { ...process.env, HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' } })
    const maintenancePage = await maintenance.firstWindow()
    const actual = await maintenance.evaluate(({ app }) => ({ home: process.getBuiltinModule('os').homedir(), userData: app.getPath('userData') }))
    expect(realpathSync(actual.home)).toBe(realpathSync(ctx.tempHome.home))
    expect(realpathSync(actual.userData)).toBe(realpathSync(ctx.tempHome.userData))
    await expect(maintenancePage.getByRole('heading', { name: '备份与恢复维护窗口', exact: true })).toBeVisible()
    const backup = await maintenancePage.evaluate(async () => {
      const api = window.workspaceBackupMaintenance!, overview = await api.overview()
      if (!overview.ok) throw Error('Synthetic overview failed')
      return api.backupSpace!({ spaceId: overview.spaces[0]!.id })
    })
    expect(backup.ok).toBe(true)
  } catch (error) {
    primaryFailure = error
    console.error('Primary maintenance test failure:', error)
    throw error
  } finally {
    const log = join(ctx.tempHome.userData, 'logs/main.log')
    if (existsSync(log)) await testInfo.attach('isolated-main-log', { body: readFileSync(log), contentType: 'text/plain' })
    // 交接后窗口已销毁，不能再调用通用cleanup里的渲染/主进程求值。
    try { if (maintenance) await maintenance.close(); await ctx.app.close() } finally { ctx.tempHome.cleanup() }
  }
})
