import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceWriterSession } from './writerSession'
import { assertWindowsLocalDisk } from './localDisk'
import { readRegistryOverview } from './registryView'
import { WORKSPACE_BACKUP_CHANNELS, type MaintenanceOverview } from '../../shared/workspaceBackupContracts'

const directory = dirname(fileURLToPath(import.meta.url))
const admitted = app.requestSingleInstanceLock()
let window: BrowserWindow | undefined
let session: WorkspaceWriterSession | undefined
if (!admitted) app.quit()
app.on('second-instance', () => { if (window && !window.isDestroyed()) { window.restore(); window.focus() } })
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  try { session?.close() }
  catch { dialog.showErrorBox('维护锁清理未完成', '未删除其它写者或残留锁。请确认所有实例退出后检查本机维护锁；不要按时间自动删除。') }
})

void app.whenReady().then(async () => {
  if (!admitted) return
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('PLATFORM_UNSUPPORTED')
  const home = homedir()
  session = new WorkspaceWriterSession(home, assertWindowsLocalDisk)
  window = new BrowserWindow({ width: 860, height: 620, minWidth: 520, minHeight: 420, show: false,
    webPreferences: { preload: join(directory, '../preload/maintenance.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const owner = window
  ipcMain.handle(WORKSPACE_BACKUP_CHANNELS.overview, (event): MaintenanceOverview => {
    if (owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw Error('UNAUTHORIZED_SENDER')
    try { return { ok: true, spaces: readRegistryOverview(home) } }
    catch { return { ok: false, code: 'REGISTRY_INVALID' } }
  })
  owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  owner.webContents.on('will-navigate', event => event.preventDefault())
  owner.on('ready-to-show', () => owner.show())
  owner.on('closed', () => { window = undefined })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) await owner.loadURL(new URL('maintenance.html', devUrl).href)
  else await owner.loadFile(join(directory, '../renderer/maintenance.html'))
}).catch(() => {
  dialog.showErrorBox('维护窗口未启动', '平台、磁盘或写锁检查未通过。没有打开或迁移资产数据库。请关闭其它实例并检查本机目录与残留锁。')
  app.quit()
})
