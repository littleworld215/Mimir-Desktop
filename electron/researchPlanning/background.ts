import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import { getStoreValue, setStoreValue } from '../library/store'
import { PLANNING_NOTICE_CHANNEL, type PlanningBackgroundState } from '../../shared/researchPlanningContracts'
import { createPlanningBackgroundPreferences } from './backgroundPreferences'
import { createPlanningNativeBackground } from './nativeBackground'
import { createPlanningReminders } from './reminders'
import { planningRuntime } from './runtime'
import { PlanningError } from './validation'

let native: ReturnType<typeof createPlanningNativeBackground> | undefined
let preferences: ReturnType<typeof createPlanningBackgroundPreferences> | undefined
let reminders: ReturnType<typeof createPlanningReminders> | undefined
let refreshError: string | null = null
function required() { if (!preferences) throw new PlanningError('MAINTENANCE_BLOCKED', '科研计划后台尚未准备好'); return preferences }
function refresh() {
  try { reminders?.refresh(); refreshError = null } catch { refreshError = 'NOTIFICATION_CLOSE_FAILED' }
}
export const planningBackground = {
  get: (): PlanningBackgroundState => ({ ...required().get(), reminderStatus: { checkedAt: null, delivered: 0, pending: 0, ...reminders?.status(), ...(refreshError ? { errorCode: refreshError } : { errorCode: reminders?.status().errorCode ?? null }) } }),
  save(expected: number, input: unknown, assertCurrent: () => void) { required().save(expected, input, assertCurrent); refresh(); return planningBackground.get() }
}
/** Called once after ordinary-mode initialization, never by maintenance startup. */
export function startPlanningBackground(options: { window(): BrowserWindow | null; iconPath: string }) {
  if (native) throw Error('PLANNING_BACKGROUND_ALREADY_STARTED')
  const showWindow = () => { const win = options.window(); if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } }
  const icon = nativeImage.createFromPath(options.iconPath).resize({ width: process.platform === 'darwin' ? 18 : 20, height: process.platform === 'darwin' ? 18 : 20 })
  native = createPlanningNativeBackground({
    platform: process.platform, packaged: app.isPackaged, executable: process.execPath, userData: app.getPath('userData'),
    trayAvailable: () => !icon.isEmpty(), createTray: () => new Tray(icon),
    menu: items => Menu.buildFromTemplate(items), showWindow, quit: () => app.quit(),
    getLogin: value => app.getLoginItemSettings(value), setLogin: value => app.setLoginItemSettings(value),
    notificationsAvailable: () => Notification.isSupported(), createNotice: value => new Notification({ ...value, silent: false })
  })
  preferences = createPlanningBackgroundPreferences({ read: () => getStoreValue('settings'), write: value => setStoreValue('settings', value) }, native)
  reminders = createPlanningReminders({ runtime: planningRuntime, enabled: () => required().readFlags().reminders, show: (value, signal) => native!.show(value, signal), closeAll: () => native!.closeAll(), open: (scope, itemId) => {
    const win = options.window(); if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    showWindow(); win.webContents.send(PLANNING_NOTICE_CHANNEL, { scope, itemId })
  } })
  // Restore tray/reminders already explicitly enabled in this profile. Do NOT re-register
  // startup at boot: installing a new copy must not silently modify OS launch entries.
  if (preferences.readFlags().tray) native.setTray(true)
  refresh()
}
export const planningBackgroundSpaceChanged = () => refresh()
export const shouldKeepPlanningWindow = () => native?.trayActive() === true && preferences?.readFlags().tray === true
export async function stopPlanningBackground() {
  try { await reminders?.stop() } finally { native?.setTray(false) }
}
