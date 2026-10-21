import { expect, it, vi } from 'vitest'
import { createPlanningBackgroundPreferences } from '../../../electron/researchPlanning/backgroundPreferences'

function setup() {
  let settings: unknown = { models: [{ id: 'model', apiKey: 'synthetic-only' }], untouched: { preserve: true } }, tray = false, startup = false
  const storage = { read: () => settings, write: vi.fn((next: unknown) => { settings = next }) }
  const adapter = { trayAvailable: () => true, trayActive: () => tray, setTray: vi.fn((next: boolean) => { tray = next }), startupAvailable: () => true, startupRegistered: () => startup, setStartup: vi.fn((next: boolean) => { startup = next }), notificationsAvailable: () => true }
  const preferences = createPlanningBackgroundPreferences(storage, adapter)
  return { preferences, adapter, storage, settings: () => settings }
}
it('首读三项默认关闭，不写文件、不修改OS启动项，不暴露其他配置', () => {
  const { preferences, storage, adapter } = setup()
  expect(preferences.get()).toMatchObject({ preferences: { revision: 0, tray: false, startup: false, reminders: false }, startupRegistered: false, trayActive: false })
  expect(preferences.get()).not.toHaveProperty('models'); expect(storage.write).not.toHaveBeenCalled(); expect(adapter.setStartup).not.toHaveBeenCalled(); expect(adapter.setTray).not.toHaveBeenCalled()
})
it('明确保存才修改自有启动项与托盘，保留模型和未知键；修订冲突不产生副作用', () => {
  const { preferences, adapter, settings } = setup()
  const result = preferences.save(0, { tray: true, startup: true, reminders: true }, () => {})
  expect(result).toMatchObject({ preferences: { revision: 1, tray: true, startup: true, reminders: true }, startupRegistered: true, trayActive: true })
  expect(settings()).toMatchObject({ models: [{ id: 'model', apiKey: 'synthetic-only' }], untouched: { preserve: true } })
  expect(() => preferences.save(0, { tray: false, startup: false, reminders: false }, () => {})).toThrow()
  expect(adapter.setStartup).toHaveBeenCalledTimes(1)
})
it('持久化失败恢复已修改的原生状态和原配置，不宣布启用成功', () => {
  const { preferences, storage, adapter, settings } = setup(), before = structuredClone(settings())
  storage.write.mockImplementationOnce(() => { throw Error('synthetic disk failure') })
  expect(() => preferences.save(0, { tray: true, startup: true, reminders: true }, () => {})).toThrow()
  expect(adapter.trayActive()).toBe(false); expect(adapter.startupRegistered()).toBe(false); expect(settings()).toEqual(before)
  expect(preferences.get().preferences.revision).toBe(0)
})
it('未支持/不可确认的系统注册、非法字段或空间变化均保留输入并拒绝副作用', () => {
  const { preferences, adapter, storage } = setup()
  adapter.startupAvailable = () => false
  expect(() => preferences.save(0, { tray: true, startup: true, reminders: false }, () => {})).toThrow()
  expect(() => preferences.save(0, { tray: false, startup: false, reminders: false, path: 'C:/private' }, () => {})).toThrow()
  expect(() => preferences.save(0, { tray: true, startup: false, reminders: true }, () => { throw Error('SPACE_CHANGED') })).toThrow()
  expect(storage.write).not.toHaveBeenCalled(); expect(adapter.setTray).not.toHaveBeenCalled()
})
