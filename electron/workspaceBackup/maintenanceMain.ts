import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceWriterSession } from './writerSession'
import { assertWindowsLocalDisk } from './localDisk'
import { readRegistryOverview } from './registryView'
import { listRestoreArchives } from './restoreMain'
import {
  WORKSPACE_BACKUP_CHANNELS,
  type MaintenanceArchiveCandidate,
  type MaintenanceOverview
} from '../../shared/workspaceBackupContracts'

/** 归档候选所在目录（与批次 2 备份默认落点一致；**只读浏览**，不建目录）。 */
const ARCHIVE_DIRECTORY_NAME = 'backups'

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
  /**
   * 只信任「当前维护窗口主框架」的请求。
   *
   * 与普通模式的 `installWorkspaceMaintenanceHandler` 同口径：防止被注入的子框架 /
   * 其它窗口旁路触发恢复（恢复会写注册表与用户资料盘，是最敏感的写路径）。
   */
  const trusted = (event: unknown): boolean => {
    const sender = (event as { sender?: unknown }).sender
    return Boolean(owner && !owner.isDestroyed() && sender === owner.webContents)
  }
  /** 统一的只读清单：空间名 + 归档候选。**不建目录、不写任何东西**。 */
  const buildOverview = async (): Promise<MaintenanceOverview> => {
    let spaces: Array<{ id: string; name: string }>
    try {
      spaces = readRegistryOverview(home)
    } catch {
      return { ok: false, code: 'REGISTRY_INVALID' }
    }
    // 归档候选是**可选增强**：目录不存在或读取失败时退化为纯空间清单（旧行为），
    // 绝不让「备份目录还没建」把整个维护窗口的只读清单拖成失败。
    let archives: MaintenanceArchiveCandidate[] = []
    try {
      archives = await listRestoreArchives(join(home, ARCHIVE_DIRECTORY_NAME))
    } catch {
      archives = []
    }
    return { ok: true, spaces, archives }
  }
  ipcMain.handle(WORKSPACE_BACKUP_CHANNELS.overview, (event): Promise<MaintenanceOverview> => {
    if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
    return buildOverview()
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
