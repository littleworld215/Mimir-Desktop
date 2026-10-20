import { test, expect, chromium, _electron as electron, type Browser } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createTempHome } from '../helpers/tempHome'
import { defaultSeed, writeSeed } from '../fixtures/seed'
import { mainEntry, repoRoot } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
import { createRequire } from 'node:module'

// 独立OS进程 + 仅本机CDP观察，不替换app.relaunch/app.exit或锁释放端口。
test('真实系统重启进入同profile维护，备份合成空间并释放维护锁', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const temp = createTempHome()
  const seed = defaultSeed(temp.home)
  writeSeed(temp, seed)
  const marker = join(seed.workspaces[0]!.path, '.synthetic-marker')
  writeFileSync(marker, 'synthetic maintenance relaunch\n', 'utf8')
  const packaged = process.env.MIMIR_E2E_PACKAGED
  const executable = packaged ? resolve(packaged) : createRequire(import.meta.url)('electron') as string
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(Error('No loopback port')); return }
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
  const env = { ...process.env, HOME: temp.home, USERPROFILE: temp.home,
    MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' }
  const output: Buffer[] = []
  let browser: Browser | undefined
  let primaryFailed = false
  const endpoint = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      const info = await response.json() as { webSocketDebuggerUrl?: string }
      return info.webSocketDebuggerUrl ?? ''
    } catch { return '' }
  }
  // 清理只接受该唯一profile及精确exe，不依据进程名称广泛终止日常程序。
  const ownedProcesses = (): number[] => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $env:MIMIR_PROBE_EXE -and $_.CommandLine -and $_.CommandLine.Contains($env:MIMIR_PROBE_PROFILE)} | ForEach-Object {[int]$_.ProcessId}); ConvertTo-Json -InputObject $rows -Compress"],
    { env: { ...env, MIMIR_PROBE_EXE: executable, MIMIR_PROBE_PROFILE: `--user-data-dir=${temp.userData}` }, windowsHide: true, encoding: 'utf8', timeout: 10_000 })) as number[]
  try {
    const original = await electron.launch({ executablePath: executable,
      args: [...(packaged ? [] : [mainEntry]), `--user-data-dir=${temp.userData}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], cwd: repoRoot, env })
    const child = original.process()
    const actualPaths = await original.evaluate(({ app }) => ({ home: process.getBuiltinModule('os').homedir(), userData: app.getPath('userData'), exe: process.execPath, packaged: app.isPackaged }))
    expect(realpathSync(actualPaths.home)).toBe(realpathSync(temp.home))
    expect(realpathSync(actualPaths.userData)).toBe(realpathSync(temp.userData))
    expect(realpathSync(actualPaths.exe)).toBe(realpathSync(executable))
    expect(actualPaths.packaged).toBe(Boolean(packaged))
    child.stdout?.on('data', data => output.push(Buffer.from(data)))
    child.stderr?.on('data', data => output.push(Buffer.from(data)))
    let spawnError: Error | undefined
    child.once('error', error => { spawnError = error })
    // 成功路径隔离外网：原有“在途刷新取消/失败即阻断”规则由producerStop回归保留。
    // 仅替换会议HTTP响应，等待后台缓存实际发布；不替换任何重启/退出/排空/写锁方法。
    await original.evaluate(({ net }) => {
      const actualFetch = net.fetch.bind(net)
      net.fetch = (input, init) => String(input) === 'https://ccfddl.github.io/conference/allconf.yml'
        ? Promise.resolve(new Response('- title: SYNTHETIC\n  confs:\n    - id: s2026\n      year: 2026\n'))
        : actualFetch(input, init)
    })
    await expect.poll(async () => { if (spawnError) throw spawnError; return endpoint() }, { timeout: 20_000 }).not.toBe('')
    const originalEndpoint = await endpoint()
    browser = await chromium.connectOverCDP(originalEndpoint)
    await expect.poll(() => browser!.contexts()[0]?.pages().length ?? 0).toBeGreaterThan(0)
    const cache = join(seed.workspaces[0]!.path, '.mimir/venue-deadlines.cache.json')
    await expect.poll(() => existsSync(cache)).toBe(true)
    expect(JSON.parse(readFileSync(cache, 'utf8')).venues[0].title).toBe('SYNTHETIC')
    const page = browser.contexts()[0]!.pages()[0]!
    const created = await page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error('Synthetic asset scope failed')
      return api.create({ ...scope.context, input: { name: '系统重启合成资产', category: 'inbox', storageType: 'inline_text', content: 'synthetic relaunch asset\n' } })
    })
    expect(created.ok).toBe(true)
    const assetsWriter = join(seed.workspaces[0]!.path, '.mimir/assets/assets.db.writer-lock')
    expect(existsSync(assetsWriter)).toBe(true)
    await gotoModule(page, 'settings')
    await page.getByRole('main').getByRole('button', { name: '科研空间', exact: true }).click()
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('maintenance-confirmation.png') })
    await page.getByRole('button', { name: '关闭工作台并进入维护', exact: true }).click()
    await expect.poll(() => child.exitCode, { timeout: 20_000 }).toBe(0)
    await expect.poll(async () => { const value = await endpoint(); return value && value !== originalEndpoint ? value : '' }, { timeout: 20_000 }).not.toBe('')
    browser = await chromium.connectOverCDP(await endpoint())
    await expect.poll(() => browser!.contexts()[0]?.pages().length ?? 0).toBeGreaterThan(0)
    const maintenancePage = browser.contexts()[0]!.pages()[0]!
    await expect(maintenancePage.getByRole('heading', { name: '备份与恢复维护窗口', exact: true })).toBeVisible()
    const pids = ownedProcesses()
    expect(pids).not.toContain(child.pid)
    expect(pids.length).toBeGreaterThan(0)
    expect(existsSync(assetsWriter)).toBe(false)
    // 同profile只有维护桥；备份重取空间锁，资产库使用只读快照，不宣称重取资产写锁。
    const result = await maintenancePage.evaluate(async () => {
      if (window.electronAPI) throw Error('Normal bridge leaked into maintenance')
      const api = window.workspaceBackupMaintenance!
      const overview = await api.overview()
      if (!overview.ok || overview.spaces.length !== 1 || overview.spaces[0]!.id !== 'e2e-space-0001') throw Error('Wrong synthetic home')
      return api.backupSpace!({ spaceId: overview.spaces[0]!.id })
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('synthetic maintenance relaunch\n')
    const registry = join(temp.home, '.mimir/registry.writer-lock')
    expect(existsSync(registry)).toBe(true)
    expect(pids).toContain(JSON.parse(readFileSync(registry, 'utf8')).pid)
    if (!result.ok) throw Error('Synthetic backup failed')
    expect(result.hasAssetsDb).toBe(true)
    expect(result.excluded).toBe(0)
    expect(result.archiveName).not.toMatch(/[\\/]/)
    expect(existsSync(join(temp.home, 'backups', result.archiveName))).toBe(true)
    await maintenancePage.screenshot({ path: testInfo.outputPath('maintenance-after-relaunch.png') })
    await maintenancePage.evaluate(() => window.close()).catch(() => {})
    await expect.poll(() => ownedProcesses(), { timeout: 10_000 }).toEqual([])
    expect(existsSync(registry)).toBe(false)
    expect(existsSync(join(seed.workspaces[0]!.path, '.mimir/workspace.writer-lock'))).toBe(false)
    expect(existsSync(assetsWriter)).toBe(false)
    await testInfo.attach('real-relaunch-result', { body: JSON.stringify({ packaged: Boolean(packaged), originalPid: child.pid, maintenancePids: pids, originalExitCode: child.exitCode, realRelaunch: true, backupOk: result.ok, locksReleased: true }), contentType: 'application/json' })
  } catch (error) {
    primaryFailed = true
    throw error
  } finally {
    let cleanupFailure: unknown
    try {
      await testInfo.attach('isolated-process-output', { body: Buffer.concat(output), contentType: 'text/plain' })
      const log = join(temp.userData, 'logs/main.log')
      if (existsSync(log)) await testInfo.attach('isolated-main-log', { body: readFileSync(log), contentType: 'text/plain' })
    } catch (error) { cleanupFailure = error }
    try {
      // 附件失败仍必须清理；关闭CDP连接不替代应用退出，只结束已核定的测试进程。
      if (browser?.isConnected()) await browser.close().catch(() => {})
      for (const pid of ownedProcesses()) { try { process.kill(pid) } catch {} }
      await expect.poll(() => ownedProcesses(), { timeout: 10_000 }).toEqual([])
      temp.cleanup()
    } catch (error) { cleanupFailure ??= error }
    if (cleanupFailure) {
      if (primaryFailed) console.error('Synthetic cleanup also failed:', cleanupFailure)
      else throw cleanupFailure
    }
  }
})
