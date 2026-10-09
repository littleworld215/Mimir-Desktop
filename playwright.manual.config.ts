import { defineConfig } from '@playwright/test'
import { manualSessionTimeout } from './e2e/helpers/manualStepGate'

// Fail before launching Electron; ordinary automatic suites never discover this directory.
if (process.env.MIMIR_MANUAL_APPROVAL !== '1') throw Error('人工验收须显式设置 MIMIR_MANUAL_APPROVAL=1')
if (process.platform !== 'win32') throw Error('此人工入口仅适用于 Windows')

export default defineConfig({
  testDir: './e2e/manual', testMatch: '*.manual.spec.ts',
  workers: 1, fullyParallel: false, retries: 0, timeout: manualSessionTimeout(process.env.MIMIR_MANUAL_STEPWISE === '1'),
  expect: { timeout: 15_000 }, reporter: [['list']],
  outputDir: `test-results/manual-approval/${new Date().toISOString().replace(/[:.]/g, '-')}`
})
