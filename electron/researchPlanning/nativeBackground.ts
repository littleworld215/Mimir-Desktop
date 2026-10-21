import { AsyncResource } from 'node:async_hooks'
import type { EventEmitter } from 'node:events'
import type { PlanningBackgroundAdapter } from './backgroundPreferences'
import type { PlanningNotice } from './reminders'

interface TrayPort extends EventEmitter { setContextMenu(menu: unknown): void; destroy(): void; isDestroyed(): boolean }
interface NoticePort extends EventEmitter { show(): void; close(): void }
export interface NativeBackgroundDependencies {
  platform: string; packaged: boolean; executable: string; userData: string
  trayAvailable(): boolean; createTray(): TrayPort; menu(items: { label?: string; type?: 'separator'; click?(): void }[]): unknown
  showWindow(): void; quit(): void
  getLogin(options: { path: string; args: string[] }): { launchItems?: { name: string; scope: string; enabled: boolean }[]; openAtLogin?: boolean; executableWillLaunchAtLogin?: boolean }
  setLogin(options: { name: string; path: string; args: string[]; openAtLogin: boolean; enabled: boolean }): void
  notificationsAvailable(): boolean; createNotice(options: { title: string; body: string }): NoticePort
}
/** Only Electron owns these objects; renderer cannot supply executable, arguments or OS menus. */
export function createPlanningNativeBackground(deps: NativeBackgroundDependencies) {
  const callbacks = new AsyncResource('planning-native-events'), owned = new Set<{ close(): void }>()
  const login = { path: deps.executable, args: [`--user-data-dir="${deps.userData}"`] }, name = 'MimirResearchWorkbench'
  let tray: TrayPort | undefined, closeFailed = false
  const fresh = (fn: () => void) => () => callbacks.runInAsyncScope(fn)
  const adapter: PlanningBackgroundAdapter & { show(notice: PlanningNotice, signal: AbortSignal): Promise<boolean>; closeAll(): void } = {
    trayAvailable: () => deps.trayAvailable(),
    trayActive: () => Boolean(tray && !tray.isDestroyed()),
    setTray(on) {
      if (!on) { if (tray) { deps.showWindow(); tray.destroy(); tray = undefined } return }
      if (adapter.trayActive()) return
      if (!deps.trayAvailable()) throw Error('TRAY_UNAVAILABLE')
      const next = deps.createTray()
      try {
        next.setContextMenu(deps.menu([{ label: '打开科研工作台', click: fresh(deps.showWindow) }, { type: 'separator' }, { label: '退出（保存检查并排空任务）', click: fresh(deps.quit) }]))
        next.on('click', fresh(deps.showWindow)); tray = next
      } catch (error) { next.destroy(); throw error }
    },
    startupAvailable: () => deps.packaged && ['win32', 'darwin'].includes(deps.platform),
    startupRegistered() {
      if (!adapter.startupAvailable()) return null
      const state = deps.getLogin(login)
      if (deps.platform === 'win32') return (state.launchItems ?? []).some(v => v.name === name && v.scope === 'user' && v.enabled)
      return typeof state.openAtLogin === 'boolean' ? state.openAtLogin : null
    },
    setStartup(on) { if (!adapter.startupAvailable()) throw Error('STARTUP_UNAVAILABLE'); deps.setLogin({ ...login, name, openAtLogin: on, enabled: on }) },
    notificationsAvailable: () => deps.notificationsAvailable(),
    show(value, signal) {
      if (signal.aborted || !deps.notificationsAvailable()) return Promise.resolve(false)
      return new Promise<boolean>((resolve, reject) => {
        let notice: NoticePort, settled = false, cleaned = false, timeout: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined
        const finish = (shown: boolean) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(shown) } }
        const cleanup = () => { if (cleaned) return; cleaned = true; clearTimeout(timeout); clearTimeout(expiry); signal.removeEventListener('abort', close); owned.delete(owner) }
        const close = () => {
          try { notice?.close(); finish(false) }
          catch (error) { closeFailed = true; if (!settled) { settled = true; reject(error) } }
          finally { cleanup() }
        }
        const owner = { close }
        try {
          notice = deps.createNotice({ title: '科研计划 · 待办提醒', body: `${value.title}\n截止：${value.dueDate}` })
          owned.add(owner)
          notice.once('show', () => { finish(true); expiry = setTimeout(close, 5 * 60_000); expiry.unref?.() })
          notice.once('failed', close); notice.once('close', () => { finish(false); cleanup() })
          notice.once('click', fresh(() => { try { if (!signal.aborted && !cleaned) value.onClick() } finally { close() } }))
          signal.addEventListener('abort', close, { once: true })
          timeout = setTimeout(close, 10_000); timeout.unref?.()
          if (signal.aborted) close(); else notice.show()
        } catch (error) { cleanup(); if (!settled) { settled = true; reject(error) } }
      })
    },
    closeAll() { for (const entry of [...owned]) entry.close(); if (closeFailed) throw Error('NOTIFICATION_CLOSE_FAILED') }
  }
  return adapter
}
