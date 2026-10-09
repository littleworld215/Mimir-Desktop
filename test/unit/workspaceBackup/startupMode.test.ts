import { expect, it } from 'vitest'
import { join } from 'node:path'
it('显式维护启动与外部MCP互斥，普通启动不改变原模式', async () => {
  const path = join(process.cwd(), 'electron/workspaceBackup/startupMode.ts')
  const mod = await import(/* @vite-ignore */ path).catch(() => ({} as any))
  expect(mod.startupMode).toBeTypeOf('function')
  expect(mod.startupMode(['mimir.exe'])).toBe('normal')
  expect(mod.startupMode(['mimir.exe', '--workspace-maintenance'])).toBe('maintenance')
  expect(() => mod.startupMode(['mimir.exe', '--workspace-maintenance', '--assets-mcp'])).toThrow()
})
