import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { launchApp } from '../fixtures/launch'

test('Electron内置Node加载SDK构建模块并完成stdio握手（隔离假宿主）', async () => {
  const launched = await launchApp()
  try {
    // CDP evaluate不提供动态import回调；用内置Node子进程走真实模块加载和stdio。
    const result = await launched.app.evaluate(async (_electron, scriptPath) => {
      const { execFile } = process.getBuiltinModule('child_process')
      return await new Promise<{ stdout: string; runtime: string }>((resolve, reject) => {
        execFile(process.execPath, [scriptPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000 }, (error, stdout) => {
          if (error) reject(error); else resolve({ stdout, runtime: process.versions.node })
        })
      })
    }, fileURLToPath(new URL('../../scripts/checkAssetsMcpStdio.mjs', import.meta.url)))
    expect(result.stdout).toContain('4/4 PASS')
    expect(result.runtime).toMatch(/^20\./)
  } finally { await launched.cleanup() }
})
