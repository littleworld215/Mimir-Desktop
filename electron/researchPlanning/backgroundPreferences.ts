import { z } from 'zod'
import type { PlanningBackgroundPreferences, PlanningBackgroundState } from '../../shared/researchPlanningContracts'
import { planningRevision, PlanningError } from './validation'

export const planningBackgroundInputSchema = z.object({ tray: z.boolean(), startup: z.boolean(), reminders: z.boolean() }).strict()
const preferencesSchema = planningBackgroundInputSchema.extend({ schemaVersion: z.literal(1), revision: planningRevision })
export const PLANNING_BACKGROUND_KEY = 'researchPlanningBackground'
interface Storage { read(): unknown; write(settings: Record<string, unknown>): void }
export interface PlanningBackgroundAdapter {
  trayAvailable(): boolean; trayActive(): boolean; setTray(on: boolean): void
  startupAvailable(): boolean; startupRegistered(): boolean | null; setStartup(on: boolean): void
  notificationsAvailable(): boolean
}
/** OS操作只由显式保存触发；普通读取不注册自启或创建托盘。 */
export function createPlanningBackgroundPreferences(storage: Storage, adapter: PlanningBackgroundAdapter) {
  function snapshot() {
    const raw = storage.read()
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new PlanningError('CORRUPT_DATA', '全局设置不可读，原文件保留')
    const settings = (raw ?? {}) as Record<string, unknown>, value = settings[PLANNING_BACKGROUND_KEY]
    let preferences: PlanningBackgroundPreferences = { schemaVersion: 1, revision: 0, tray: false, startup: false, reminders: false }
    if (value !== undefined) {
      if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new PlanningError('UNSUPPORTED_VERSION', '后台偏好版本较新，未重置设置')
      const parsed = preferencesSchema.safeParse(value)
      if (!parsed.success) throw new PlanningError('CORRUPT_DATA', '后台偏好格式异常，原设置保留')
      preferences = parsed.data
    }
    return { settings, preferences }
  }
  function status(): Omit<PlanningBackgroundState, 'preferences'> {
    const trayAvailable = adapter.trayAvailable(), startupAvailable = adapter.startupAvailable()
    let startupRegistered: boolean | null = null
    if (startupAvailable) { try { startupRegistered = adapter.startupRegistered() } catch { /* 不能把查询失败伪装成关闭 */ } }
    return { trayAvailable, trayActive: adapter.trayActive(), startupAvailable, startupRegistered, notificationsAvailable: adapter.notificationsAvailable() }
  }
  return {
    readFlags: () => snapshot().preferences,
    get: (): PlanningBackgroundState => ({ preferences: snapshot().preferences, ...status() }),
    save(expected: number, input: unknown, assertCurrent: () => void): PlanningBackgroundState {
      assertCurrent()
      const parsed = planningBackgroundInputSchema.safeParse(input)
      if (!parsed.success || !planningRevision.safeParse(expected).success) throw new PlanningError('BAD_REQUEST', '后台偏好字段非法')
      const before = snapshot()
      if (before.preferences.revision !== expected) throw new PlanningError('CONFLICT', '后台偏好已有更新，请保留输入并重新读取', before.preferences.revision)
      const native = status(), next = parsed.data
      const manageStartup = next.startup !== before.preferences.startup || native.startupAvailable && native.startupRegistered !== null && native.startupRegistered !== next.startup
      if (manageStartup && (!native.startupAvailable || native.startupRegistered === null)) throw new PlanningError('BAD_REQUEST', '当前运行方式无法安全确认开机启动，请在安装包中核对系统状态')
      if (next.tray && !native.trayAvailable && !before.preferences.tray) throw new PlanningError('BAD_REQUEST', '系统托盘当前不可用，未启用隐藏窗口')
      if (next.reminders && !native.notificationsAvailable && !before.preferences.reminders) throw new PlanningError('BAD_REQUEST', '系统通知接口不可用，未启用提醒')
      let trayAttempted = false, startupAttempted = false, writeAttempted = false
      try {
        if (native.trayAvailable && native.trayActive !== next.tray) { trayAttempted = true; adapter.setTray(next.tray); if (adapter.trayActive() !== next.tray) throw Error('TRAY_NOT_APPLIED') }
        if (manageStartup) { startupAttempted = true; adapter.setStartup(next.startup); if (adapter.startupRegistered() !== next.startup) throw Error('STARTUP_NOT_APPLIED') }
        assertCurrent()
        const preferences: PlanningBackgroundPreferences = { ...next, schemaVersion: 1, revision: expected + 1 }
        writeAttempted = true; storage.write({ ...before.settings, [PLANNING_BACKGROUND_KEY]: preferences })
        return { preferences, ...status() }
      } catch (error) {
        let failed = false
        if (writeAttempted) { try { storage.write(before.settings) } catch { failed = true } }
        if (startupAttempted) { try { adapter.setStartup(native.startupRegistered!); if (adapter.startupRegistered() !== native.startupRegistered) failed = true } catch { failed = true } }
        if (trayAttempted) { try { adapter.setTray(native.trayActive); if (adapter.trayActive() !== native.trayActive) failed = true } catch { failed = true } }
        if (failed) throw new PlanningError('WRITE_FAILED', '后台偏好未保存，系统状态未能完整回滚；请保持窗口打开并核对托盘和系统开机项')
        if (error instanceof PlanningError) throw error
        throw new PlanningError('WRITE_FAILED', '后台偏好未保存，已恢复原配置和可确认的系统状态；输入保留')
      }
    }
  }
}
