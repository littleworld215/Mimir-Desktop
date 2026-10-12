import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceWriterSession } from './writerSession'
import { assertWindowsLocalDisk } from './localDisk'
import { readRegistryOverview } from './registryView'
import { listRestoreArchives } from './restoreMain'
import { buildRestoreHandler, registerRestoreHandler } from './maintenanceRestoreHandler'
import { buildDoctorHandler, registerDoctorHandler } from './maintenanceDoctorHandler'
import { buildRetentionHandler, registerRetentionHandler } from './maintenanceRetentionHandler'
import { buildBackupHandler, registerBackupHandler } from './maintenanceBackupHandler'
import { redactText } from './redact'
// 归档目录名收口为共享常量（I6 批次 3.5 · T01）：与 retention / doctor 的默认值同一事实源。
import { archiveDirectory } from './directories'
import type { MaintenanceCancelResult } from '../../shared/workspaceBackupContracts'
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
      archives = await listRestoreArchives(archiveDirectory(home))
    } catch {
      archives = []
    }
    return { ok: true, spaces, archives }
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
    session: session === undefined ? undefined : { assertUsable: () => session!.assertUsable() },
    homeDir: home,
    onProgress: (progress) => {
      // 进度为**可选增强**：窗口已销毁时静默丢弃，绝不让上报失败影响恢复本身。
      if (owner && !owner.isDestroyed()) {
        // ⚠️ 脱敏兜底（I6 批次 4 §0.3）：即便服务层某条文案混入了本机绝对路径，
        // 也在**出口处**用 `redactText` 过滤（纵深防御：服务层已改文案，此处再包一层）。
        // 通道名用 `WORKSPACE_BACKUP_CHANNELS.restoreProgress`（收口批次 3 的硬编码）。
        owner.webContents.send(WORKSPACE_BACKUP_CHANNELS.restoreProgress, {
          stage: progress.stage,
          detail: redactText(progress.detail)
        })
      }
    }
  })
  registerRestoreHandler(ipcMain, trusted, restoreHandler)

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
    homeDir: home,
    onProgress: (progress) => {
      // 进度为**可选增强**：窗口已销毁时静默丢弃，绝不让上报失败影响自检本身。
      if (owner && !owner.isDestroyed()) {
        owner.webContents.send(WORKSPACE_BACKUP_CHANNELS.doctorProgress, {
          stage: progress.stage,
          // 同上：出口处再包一层脱敏，防任何绝对路径片段外泄。
          detail: redactText(progress.detail)
        })
      }
    }
  })
  registerDoctorHandler(ipcMain, trusted, doctorHandler)

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
  registerRetentionHandler(ipcMain, trusted, retentionHandler)

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
    homeDir: home,
    session: session === undefined ? undefined : { assertUsable: () => session!.assertUsable() },
    onProgress: (progress) => {
      // 进度为**可选增强**：窗口已销毁时静默丢弃，绝不让上报失败影响备份本身。
      if (owner && !owner.isDestroyed()) {
        owner.webContents.send(WORKSPACE_BACKUP_CHANNELS.backupProgress, {
          stage: progress.stage,
          // 出口处再包一层脱敏（纵深防御，与 restore/doctor 同款）。
          detail: redactText(progress.detail)
        })
      }
    }
  })
  registerBackupHandler(ipcMain, trusted, backupHandler)

  /**
   * 取消通道（批次 4 · T04）。
   *
   * ⚠️ **诚实优先**：本批 UI 侧（T05）暫不实现「真取消」（需要 AbortSignal 贯穿
   * `runMaintenanceRestore` 的每一步与 `publish` 前的安全点——那是 T05 的范围）。
   * 为避免做出「会留半成品的假取消」，此处**如实返回 `{ ok:false, code:'NOT_SUPPORTED' }`**
   * ——不是假装成功、也不改变任何写路径语义（对齐设计稿 §3.2「宁可诚实返回，也不做假取消」）。
   * 通道仍**注册**，以保证渲染层「进度/取消/结果」三件套在 UI 上可用（取消按钮会得到明确拒绝）。
   *
   * 语义（`MaintenanceCancelResult`）：`ok:true` 才代表取消请求被接受；本批恒为 `false`。
   */
  const cancelChannel = (channel: string): void => {
    ipcMain.handle(channel, (event): MaintenanceCancelResult => {
      if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
      // 本批不做「假取消」：无副作用、无竞态，明确告知暂不支持。
      return { ok: false, code: 'NOT_SUPPORTED' }
    })
  }
  cancelChannel(WORKSPACE_BACKUP_CHANNELS.doctorCancel)
  cancelChannel(WORKSPACE_BACKUP_CHANNELS.restoreCancel)

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
