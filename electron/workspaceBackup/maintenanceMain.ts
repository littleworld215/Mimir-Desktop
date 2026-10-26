import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceWriterSession } from './writerSession'
import { assertWindowsLocalDisk } from './localDisk'
import { readRegistryOverview } from './registryView'
import { listRestoreArchives } from './restoreMain'
import { acquireStagingLock, buildRestoreHandler, registerRestoreHandler } from './maintenanceRestoreHandler'
import { buildDoctorHandler, registerDoctorHandler } from './maintenanceDoctorHandler'
import { buildRetentionHandler, registerRetentionHandler } from './maintenanceRetentionHandler'
import { buildBackupHandler, registerBackupHandler } from './maintenanceBackupHandler'
import { redactText } from './redact'
// 归档目录名收口为共享常量（I6 批次 3.5 · T01）：与 retention / doctor 的默认值同一事实源。
import { archiveDirectory } from './directories'
import { RestoreRecovery } from './restoreRecovery'
import { buildRecoveryHandler, isTrustedMaintenanceRequest, registerRecoveryHandlers } from './maintenanceRecoveryHandler'
import { MaintenanceWriteGate } from './maintenanceWriteGate'
import { MaintenanceTaskManager, reportMaintenanceProgress } from './maintenanceTask'
import { selectRestoreRequest } from './maintenanceSelection'
import { registerMaintenanceTaskHandlers } from './maintenanceTaskHandler'
import {
  WORKSPACE_BACKUP_CHANNELS,
  type MaintenanceArchiveCandidate,
  type MaintenanceOverview
} from '../../shared/workspaceBackupContracts'

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
  const nativeOptions = { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: join(directory, '../..') }
  try { session = new WorkspaceWriterSession(home, assertWindowsLocalDisk) }
  catch (error) {
    // A stale or live lock is preserved; the window may only explain recovery state.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  window = new BrowserWindow({ width: 860, height: 620, minWidth: 520, minHeight: 420, show: false,
    webPreferences: { preload: join(directory, '../preload/maintenance.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const owner = window
  /**
   * 只信任「当前维护窗口主框架」的请求。
   *
   * 与普通模式的 `installWorkspaceMaintenanceHandler` 同口径：防止被注入的子框架 /
   * 其它窗口旁路触发恢复（恢复会写注册表与用户资料盘，是最敏感的写路径）。
   */
  const trusted = (event: unknown): boolean => isTrustedMaintenanceRequest(event, owner)
  const assertWritable = () => {
    if (!session) throw Error('维护写锁尚未取得。')
    session.assertUsable()
  }
  const tasks = new MaintenanceTaskManager(progress => {
    if (owner.isDestroyed()) return
    const channel = progress.kind === 'restore' ? WORKSPACE_BACKUP_CHANNELS.restoreProgress : progress.kind === 'backup' ? WORKSPACE_BACKUP_CHANNELS.backupProgress : WORKSPACE_BACKUP_CHANNELS.doctorProgress
    owner.webContents.send(channel, { ...progress, detail: redactText(progress.detail) })
  })
  registerMaintenanceTaskHandlers(ipcMain, trusted, tasks)
  const writes = new MaintenanceWriteGate(() => {
    assertWritable()
    if (tasks.current?.kind === 'doctor') throw Error('TASK_BUSY')
  })
  const takeRootLock = (root: string) => {
    assertWritable()
    const lock = acquireStagingLock(root)
    session!.ownWriterLock({ root, release: () => lock.release() })
    return lock
  }
  const recovery = new RestoreRecovery({ homeDir: home, assertUsable: assertWritable, lockRoot: takeRootLock, assetsIntegrityOptions: nativeOptions })
  owner.on('close', event => {
    if (!writes.running && !tasks.running) return
    event.preventDefault()
    void dialog.showMessageBox(owner, { type: 'info', message: '维护任务尚未完成，请稍候再关闭窗口。', buttons: ['返回维护'], noLink: true })
  })
  app.on('before-quit', event => { if (writes.running || tasks.running) event.preventDefault() })
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
      archives = await listRestoreArchives(archiveDirectory(home))
    } catch {
      archives = []
    }
    return { ok: true, spaces, archives, writable: session !== undefined }
  }
  ipcMain.handle(WORKSPACE_BACKUP_CHANNELS.overview, (event): Promise<MaintenanceOverview> => {
    if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
    return buildOverview()
  })

  /**
   * 恢复 handler（批次 3 · T05 收口）。
   *
   * ⚠️ **纪律「控制不可嵌套」**：本 handler **不**经 `installWorkspaceIpcGate`，也**不**调
   * 任何 `workspaces:*` 通道；它直接调服务层（`runMaintenanceRestore`）。恢复自身已持有
   * 写者会话（`session` 构造时即持 `registry.writer-lock`）并在内部按 §1.3 规则 4 自串行，
   * 若再被 `runControl` 包一层即死锁。**不要**把本通道加进 `ipcGate.ts` 的 `control` /
   * `workspaceChanges` 集合（那里有注释解释原因）。
   *
   * 会话健康检查用 `session?.assertUsable` 读**调用时**的模块级变量：`session` 在窗口
   * `whenReady` 时构造，handler 也在此后注册，二者时序已对齐；用可选链兜住「未就绪 → undefined」，
   * 此时 `buildRestoreHandler` 会以 `LOCK_UNAVAILABLE` 拒绝（绝不无锁写入）。
   */
  const restoreHandler = buildRestoreHandler({
    selectRequest: request => selectRestoreRequest(request, {
      assertLocal: assertWindowsLocalDisk,
      pickArchive: async suggestion => {
        const choice = await dialog.showOpenDialog(owner, { title: '选择要恢复的备份归档', defaultPath: suggestion || archiveDirectory(home), properties: ['openFile'], filters: [{ name: 'Mimir备份', extensions: ['zip'] }] })
        if (choice.canceled || choice.filePaths.length !== 1) return
        return choice.filePaths[0]
      },
      pickTarget: async suggestion => {
        const choice = await dialog.showSaveDialog(owner, { title: '选择尚不存在的新空间目录', buttonLabel: '选择新空间位置', defaultPath: suggestion || join(home, '恢复的科研空间') })
        if (choice.canceled || !choice.filePath) return
        return choice.filePath
      }
    }),
    run: (request, deps) => recovery.run(request, deps),
    assetsIntegrityOptions: nativeOptions,
    session: session === undefined ? undefined : { assertUsable: () => session!.assertUsable() },
    homeDir: home,
    lockStagingRoot: takeRootLock,
    onProgress: progress => reportMaintenanceProgress(progress)
  })
  registerRestoreHandler(ipcMain, trusted, request => writes.run(() => tasks.run('restore', () => restoreHandler(request))))
  registerRecoveryHandlers(ipcMain, trusted, buildRecoveryHandler({
    recovery,
    runWrite: action => writes.run(action),
    confirmCleanup: async view => {
      const result = await dialog.showMessageBox(owner, {
        type: 'warning', title: '清理本次恢复暂存', message: `确认清理「${view.spaceName}」的中断暂存？`,
        detail: `将核对并移除本任务暂存中的 ${view.entries} 个条目（${view.totalBytes} 字节）。确认后还会重新核对；已发布空间和原空间保留。`,
        buttons: ['保留暂存', '确认清理'], defaultId: 0, cancelId: 0, noLink: true
      })
      return result.response === 1
    }
  }))

  /**
   * 自检 / 审计 handler（批次 4 · T04）。
   *
   * ⚠️ **纪律「控制不可嵌套」**：本 handler **不**经 `installWorkspaceIpcGate`；自检是**只读**的，
   * 绝不调任何 `workspaces:*` IPC。**不要**把本通道加进 `ipcGate.ts` 的 `control` /
   * `workspaceChanges` 集合（自检/审计是只读，取消是纯信号）。
   *
   * 进度推送形态照既有 `restoreProgress`：`if (owner && !owner.isDestroyed()) owner.webContents.send(...)`。
   */
  const doctorHandler = buildDoctorHandler({
    auditAllowed: () => { try { assertWritable(); return true } catch { return false } },
    homeDir: home,
    assetsIntegrityOptions: nativeOptions,
    onProgress: progress => reportMaintenanceProgress(progress)
  })
  registerDoctorHandler(ipcMain, trusted, {
    doctor: () => writes.running ? Promise.resolve({ ok: false as const, code: 'TASK_BUSY', detail: '已有维护任务正在运行。' }) : tasks.run('doctor', () => doctorHandler.doctor()),
    auditRecent: limit => doctorHandler.auditRecent(limit)
  })

  /**
   * 保留预览 / 清理 handler（I6 批次 5 · T04）。
   *
   * ⚠️ **纪律「控制不可嵌套」**：本 handler **不**经 `installWorkspaceIpcGate`；预览是**只读**
   * （不取锁、不建目录、不写文件），清理**只**调服务层（`retentionService`），**绝不**调任何
   * `workspaces:*` IPC。**不要**把本通道加进 `ipcGate.ts` 的 `control` / `workspaceChanges`
   * 集合（K9）。
   *
   * 入参纪律（K2）：`apply` **只收 `{ confirmToken }`**——渲染层不得回传路径 / 文件列表；
   * 主进程据 token **自己重算**候选（`maintenanceRetentionHandler` 内严格规范化后再交服务层）。
   */
  const retentionHandler = buildRetentionHandler({ homeDir: home })
  registerRetentionHandler(ipcMain, trusted, { preview: () => retentionHandler.preview(), apply: request => writes.run(() => retentionHandler.apply(request)) })

  /**
   * 逐空间完整备份 handler（I6 批次 3.5 · T04）。
   *
   * ⚠️ **纪律「控制不可嵌套」**：本 handler **不**经 `installWorkspaceIpcGate`，也**不**调任何
   * `workspaces:*` 通道；它直接调服务层（`runSpaceBackup`）。**不要**把本通道加进 `ipcGate.ts`
   * 的 `control` / `workspaceChanges` 集合（K9）。
   *
   * ⚠️ **绝不调 `session.select()`（本批关键决策，重要留档）**：维护会话在备份前**只**做健康
   * 检查（`assertUsable()`）——与既有 `restoreHandler` 的形态**完全一致**。理由：`WorkspaceWriterSession`
   * 构造时**只**持 `registry.writer-lock`；每**空间**锁**只在** `select(root, maintenance)` 被调用时
   * 才取（`writerSession.ts:68/77`）。而 `runSpaceBackup` 内的 `defaultAcquireSpaceLock` 取的路径是
   * `<root>/.mimir/workspace.writer-lock`——与 `prepareSelection` 里 `acquireWorkspaceLock(canonical)`
   * 取的**同址同名**。若在 backup 前调 `select()`，会话先持锁，`runSpaceBackup` 再取同一路径必然
   * `EEXIST` → **每次备份都 `LOCK_UNAVAILABLE`（自锁）**。故此处构造 deps 时**只**暴露 `assertUsable`。
   *
   * 会话健康检查用 `session === undefined ? undefined : { assertUsable: () => session!.assertUsable() }`
   * 读**调用时**的模块级变量：`session` 在窗口 `whenReady` 时构造，handler 也在此后注册，二者时序
   * 已对齐；用 `undefined` 兜住「未就绪」→ `buildBackupHandler` 会以 `LOCK_UNAVAILABLE` 拒绝
   * （绝不无锁写入）。**照抄** restoreHandler 的写法，别把 `session` 提前捕获成常量。
   */
  const backupHandler = buildBackupHandler({
    ...nativeOptions,
    producer: { application: 'Mimir-Desktop', version: app.getVersion(), platform: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'unknown' },
    homeDir: home,
    session: session === undefined ? undefined : { assertUsable: () => session!.assertUsable() },
    onProgress: progress => reportMaintenanceProgress(progress)
  })
  registerBackupHandler(ipcMain, trusted, { backup: request => writes.run(() => tasks.run('backup', () => backupHandler.backup(request))) })

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
