import { it, expect, vi } from 'vitest'
import { createQuitFlow } from '../../electron/quitFlow'

it('取消窗口卸载不关闭后台；再次退出经窗口关闭后只清理一次', async () => {
  let windowOpen = true
  const close = vi.fn(), shutdown = vi.fn(async () => {}), quit = vi.fn()
  const flow = createQuitFlow({ hasWindow: () => windowOpen, closeWindow: close, shutdown, quit })
  const preventDefault = vi.fn()
  flow.beforeQuit({ preventDefault })
  flow.cancelClose()
  expect(close).toHaveBeenCalledTimes(1)
  expect(shutdown).not.toHaveBeenCalled()
  expect(quit).not.toHaveBeenCalled()
  flow.beforeQuit({ preventDefault })
  windowOpen = false
  flow.windowClosed()
  expect(quit).toHaveBeenCalledTimes(1)
  flow.beforeQuit({ preventDefault })
  flow.beforeQuit({ preventDefault })
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(2))
  expect(shutdown).toHaveBeenCalledTimes(1)
})
