import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { createPlanningNativeBackground } from '../../../electron/researchPlanning/nativeBackground'

function setup() {
  const tray = Object.assign(new EventEmitter(), { setContextMenu: vi.fn(), destroy: vi.fn(), isDestroyed: () => false })
  let entries: { name: string; path: string; args: string[]; scope: string; enabled: boolean }[] = []
  const notices: (EventEmitter & { show(): void; close(): void })[] = []
  const setLogin = vi.fn((v: { name: string; path: string; args: string[]; openAtLogin: boolean }) => { entries = [{ ...v, scope: 'user', enabled: v.openAtLogin }] })
  const showWindow = vi.fn(), quit = vi.fn()
  const deps = { platform: 'win32', packaged: true, executable: 'C:\\Mimir\\Mimir.exe', userData: 'C:\\Synthetic Profile', trayAvailable: () => true, createTray: vi.fn(() => tray), menu: (v: unknown) => v, showWindow, quit,
    getLogin: vi.fn(() => ({ launchItems: entries })), setLogin, notificationsAvailable: () => true,
    createNotice: vi.fn(() => { const notice = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn(() => { notice.emit('close') }) }); notices.push(notice); return notice }) }
  return { deps, tray, notices, adapter: createPlanningNativeBackground(deps), setLogin, showWindow, quit }
}
it('开机项只管理独立用户项、固定安装路径及profile参数，读取与写入使用相同参数', () => {
  const f = setup(); expect(f.adapter.startupRegistered()).toBe(false)
  f.adapter.setStartup(true); expect(f.adapter.startupRegistered()).toBe(true)
  expect(f.setLogin).toHaveBeenCalledWith({ name: 'MimirResearchWorkbench', path: f.deps.executable, args: ['--user-data-dir="C:\\Synthetic Profile"'], openAtLogin: true, enabled: true })
  expect(f.deps.getLogin).toHaveBeenLastCalledWith({ path: f.deps.executable, args: ['--user-data-dir="C:\\Synthetic Profile"'] })
  const dev = createPlanningNativeBackground({ ...f.deps, packaged: false }); expect(dev.startupAvailable()).toBe(false); expect(() => dev.setStartup(true)).toThrow()
})
it('原生托盘事件在创建请求结束后仍有效，销毁托盘先显示窗口，退出走正常退出入口', async () => {
  const f = setup(), gate = new WorkspaceOperationGate()
  await gate.run({ id: 's', epoch: 'e', root: 'synthetic' }, async () => { f.adapter.setTray(true) })
  const guarded = gate.bind(() => {})
  f.tray.emit('click'); expect(f.showWindow).toHaveBeenCalledOnce(); guarded()
  const menu = f.tray.setContextMenu.mock.calls[0][0] as { click?: () => void }[]
  menu.find(v => v.click && v !== menu[0])?.click?.(); expect(f.quit).toHaveBeenCalledOnce()
  f.adapter.setTray(false); expect(f.showWindow).toHaveBeenCalledTimes(2); expect(f.tray.destroy).toHaveBeenCalledOnce()
})
it('收到原生show事件才成功；失败、取消均关闭且不会冒充已经送达', async () => {
  const f = setup(), controller = new AbortController(), click = vi.fn()
  const first = f.adapter.show({ title: '合成待办', itemId: 'one', dueDate: '2026-10-21', onClick: click }, controller.signal)
  f.notices[0].emit('failed', {}, 'system detail'); expect(await first).toBe(false)
  const second = f.adapter.show({ title: '合成待办', itemId: 'two', dueDate: '2026-10-21', onClick: click }, controller.signal)
  f.notices[1].emit('show'); expect(await second).toBe(true); f.notices[1].emit('click'); expect(click).toHaveBeenCalledOnce()
  const third = f.adapter.show({ title: '取消', itemId: 'three', dueDate: '2026-10-21', onClick: click }, controller.signal)
  controller.abort(); expect(await third).toBe(false); f.adapter.closeAll(); expect(f.notices.every(n => vi.mocked(n.close).mock.calls.length > 0)).toBe(true)
})
it('旧原生通知超时后关闭；不支持或预先取消不创建通知', async () => {
  vi.useFakeTimers()
  try { const f = setup(), ctrl = new AbortController(); ctrl.abort(); expect(await f.adapter.show({ title: 'x', itemId: 'a', dueDate: '2026-10-21', onClick() {} }, ctrl.signal)).toBe(false); expect(f.notices).toHaveLength(0)
    const pending = f.adapter.show({ title: 'x', itemId: 'a', dueDate: '2026-10-21', onClick() {} }, new AbortController().signal); await vi.advanceTimersByTimeAsync(10_000); expect(await pending).toBe(false); expect(f.notices[0].close).toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
it('原生关闭异常返回失败并阻断排空，不从取消事件抛出未捕获异常', async () => {
  const f = setup(), controller = new AbortController()
  const showing = f.adapter.show({ title: '关闭失败', itemId: 'a', dueDate: '2026-10-21', onClick() {} }, controller.signal)
  vi.mocked(f.notices[0].close).mockImplementation(() => { throw Error('native close failed') })
  const failure = expect(showing).rejects.toThrow('native close failed')
  controller.abort(); await failure
  expect(() => f.adapter.closeAll()).toThrow('NOTIFICATION_CLOSE_FAILED')
})
