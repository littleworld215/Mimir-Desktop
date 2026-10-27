import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const calls = vi.hoisted(() => [] as Array<{ isPackaged: boolean; resourcesPath?: string; appRoot?: string }>)
vi.mock('../../../electron/assets/nativeBinding', () => ({
  resolveAssetsNativeBinding(options: { isPackaged: boolean; resourcesPath?: string; appRoot?: string }) {
    calls.push(options)
    return { nativeBinding: undefined, mode: 'default', detail: 'Node ABI for an actual temporary SQLite' }
  }
}))
import { assetsDatabaseFactory } from '../../../electron/assets/store'

const roots: string[] = []
afterEach(() => { calls.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('正常工作台资产工厂使用模块推导的应用根，不随系统启动或重启工作目录改变', () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-factory-root-')); roots.push(root)
  const originalCwd = process.cwd()
  try {
    process.chdir(root)
    const db = assetsDatabaseFactory(join(root, 'synthetic.db'), {})
    try { expect(db.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 }) } finally { db.close() }
  } finally { process.chdir(originalCwd) }
  expect(calls).toHaveLength(1)
  expect(calls[0]!.appRoot).toBe(resolve(fileURLToPath(new URL('../../../', import.meta.url))))
})
