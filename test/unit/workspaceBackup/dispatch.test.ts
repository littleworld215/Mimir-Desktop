import { expect, it, vi } from 'vitest'
import { join } from 'node:path'

async function subject() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/dispatch.ts')).catch(() => ({} as any))
  expect(mod.dispatchStartup).toBeTypeOf('function')
  return mod
}
it('普通与维护启动仅加载各自入口，维护不加载业务模块', async () => {
  const { dispatchStartup } = await subject()
  const normal = vi.fn(async () => {}), maintenance = vi.fn(async () => {})
  await dispatchStartup(['mimir.exe'], { normal, maintenance })
  expect(normal).toHaveBeenCalledTimes(1)
  expect(maintenance).not.toHaveBeenCalled()
  normal.mockClear()
  await dispatchStartup(['mimir.exe', '--workspace-maintenance'], { normal, maintenance })
  expect(normal).not.toHaveBeenCalled()
  expect(maintenance).toHaveBeenCalledTimes(1)
})
it('冲突启动参数在加载任何入口前失败', async () => {
  const { dispatchStartup } = await subject()
  const normal = vi.fn(async () => {}), maintenance = vi.fn(async () => {})
  await expect(dispatchStartup(['--workspace-maintenance', '--assets-mcp'], { normal, maintenance })).rejects.toThrow()
  expect(normal).not.toHaveBeenCalled()
  expect(maintenance).not.toHaveBeenCalled()
})
