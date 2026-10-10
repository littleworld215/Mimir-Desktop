import { app, shell, BrowserWindow, protocol, net, dialog, ipcMain } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { setupIpcHandlers, disposeIpcResources } from './ipc'
import { agentService, stopAllAgentTasks } from './agent/agentService'
import { shutdownOtel } from './agent/otelTrace'
import { resetApprovalSender } from './agent/approval'
import { isLatexPdfAllowed } from './latex'
import { existsSync } from 'fs'
import { paperPdfFileName } from './library/arxiv'
import { figureFilePath } from './figures/figuresService'
import { loadStore, getStoreValue, spaceRoot, captureWorkspaceOperation, installWorkspaceOperationProtection } from './library/store'
import { workspaceOperationGate } from './workspaceBackup/operationGate'
import { WorkspaceWriterSession } from './workspaceBackup/writerSession'
import { assertWindowsLocalDisk } from './workspaceBackup/localDisk'
import { installWorkspaceIpcGate, installWorkspaceMaintenanceHandler } from './workspaceBackup/ipcGate'
import { MaintenanceHandoff } from './workspaceBackup/handoff'
import { homedir } from 'node:os'
import { setS2KeyProvider, setOpenAlexKeyProvider } from './agent/paperSearch'
import { setOpenAlexKeyProvider as oaLocationSetOpenAlexKeyProvider } from './library/oaLocation'
import { startVenueDeadlineLoop } from './venues/venuesService'
import { setTokenCounter } from './agent/contextManager'
import { countTokensCached } from './agent/tokenizer'
import { isSafeExternalUrl } from './safeUrl'
import { stopBridge } from './plugins/bridge'
import log, { initLogger } from './logger'
import { assetsStoreManager } from './assets/store'
import { createQuitFlow } from './quitFlow'
import { startAssetsMcpHost, externalApprovalPreview } from './assets/mcp/host'
import { createExternalApproval } from './assets/mcp/approval'
import { safeBrokerError } from './assets/mcp/localTransport'

// 仅显式启动参数启用外部MCP；默认运行方式保持不变。
let assetsMcpStartup: Promise<Awaited<ReturnType<typeof startAssetsMcpHost>> | null> | null = null
let assetsMcpAbort: AbortController | undefined

const __dirname = dirname(fileURLToPath(import.meta.url))

// 普通入口日志设施先于业务初始化。早期入口加载失败由bootstrap显式报告。
initLogger()

let mainWindow: BrowserWindow | null = null
/** 供 IPC 层读取当前窗口的可变引用：窗口重建/关闭后始终指向最新实例。 */
const windowRef: { current: BrowserWindow | null } = { current: null }

/**
 * **I6 整科研空间保护**：普通启动持有的写者会话（注册表锁 + 当前空间锁）。
 *
 * 为什么必须在启动时先持有：`~/` 注册表与空间根各自有独立写锁，加载 store 前先占锁，
 * 才能保证「受保护初始化」期间不会有两个写者同时改指针/缓存。锁的获取/释放语义见
 * `workspaceBackup/writerSession.ts` 与 `operationGate.ts`；本文件只负责装配与退出清理。
 */
let writerSession: WorkspaceWriterSession | undefined
/** 维护交接状态机：窗口关闭 → 排空 → 关闭资源 → 启动维护窗口。 */
let maintenanceHandoff: MaintenanceHandoff | undefined

/**
 * 空间管理控制（workspaces:*）与维护交接的**统一超时预算**。
 *
 * 为什么单独给预算：这类操作要先排空所有在途任务再串行执行，耗时取决于在途写入；
 * 超时后闸门保持阻断（不接受新写入），而不是放行进入半完成状态——由用户重启恢复。
 */
const WORKSPACE_CONTROL_TIMEOUT_MS = 60_000
/** 维护交接（排空 + 关资源 + 启动维护窗口）的总预算，含同步原生调用阻塞。 */
const WORKSPACE_HANDOFF_TIMEOUT_MS = 30_000

/**
 * **单实例保护**（I0-03 / 见整合计划 §2.4）。
 *
 * 两个应用实例同时运行会各自打开资产库 SQLite 写连接，属数据安全红线（WAL 与文件锁并发写
 * 可能损坏库）。因此：拿不到锁的第二个实例直接退出，并让已有实例把窗口带到前台。
 * 单实例只解决**同一台机器**的并发；跨设备同步目录的并发写仍由「单写者」纪律约束。
 */
const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = mainWindow
    if (win !== null && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

/** 从全局设置（~/.mimir/store.json 的 settings，见 library/store.ts）取出当前选中模型并初始化 Agent。 */
async function initAgentFromSettings(): Promise<void> {
  const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
  const models = (settings.models as Array<Record<string, unknown>> | undefined) || []
  const selectedModelId = settings.selectedModelId as string | undefined
  const selected = models.find((m) => m.id === selectedModelId) || models[0]

  if (selected?.apiKey) {
    try {
      await agentService.initialize({
        apiKey: selected.apiKey as string,
        // 兜底模型名与 ipc/index.ts 保持一致：`deepseek-chat` 已退役。
        model: (selected.modelId as string) || 'deepseek-flash',
        baseUrl: selected.baseUrl as string | undefined,
        // 模型设置里的「支持推理」显式开关；未设置时由 autoReasoningFor(baseUrl) 兜底。
        reasoning: selected.supportsReasoning as boolean | undefined
      })
      log.info('Agent 已从保存的设置初始化')
    } catch (error) {
      // 非致命（用户可在设置里重填 Key 后继续用），但必须落日志而不是 console 里沉掉。
      log.error('Agent 初始化失败:', error)
    }
  }
}

/**
 * 把致命失败**显式暴露**出来：落日志 + 系统错误框。
 *
 * 为什么必须有：启动链此前没有兜底，任何一步抛错都只让 `app.whenReady().then(...)` 的
 * Promise 静默 reject —— 用户看到的是「双击图标后窗口永远不出现」，日志里也没有线索。
 * 失败必须可见，因此这里同时写主进程日志并弹一个用户能看见的框。
 */
function reportFatalError(title: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  log.error(`[${title}] ${detail}`)
  try {
    dialog.showErrorBox(title, detail)
  } catch (dialogError) {
    // 极早期（对话框不可用）时至少别把原始错误吞掉。
    console.error(title, detail, dialogError)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      // electron-vite 在 package.json 为 ESM（"type": "module"）时会把 preload
      // 产物命名为 index.mjs；指向 .js 会导致 preload 加载失败、渲染进程拿不到
      // contextBridge 暴露的 window.electronAPI。
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  windowRef.current = mainWindow

  mainWindow.webContents.on('will-prevent-unload', event => {
    if (!mainWindow) return
    const closingWindow = mainWindow
    const choice = dialog.showMessageBoxSync(closingWindow, { type: 'warning', buttons: ['留在这里', '保存后关闭', '丢弃未保存输入并关闭'], defaultId: 0, cancelId: 0, title: '存在未保存输入或在途操作', message: '保存成功后才能关闭。正在执行的操作请等待完成；丢弃输入后退出仍会排空资产写入。' })
    if (choice === 2) event.preventDefault()
    else if (choice === 1) {
      // Only invokes our renderer guard. No body text or user-provided script is evaluated.
      void closingWindow.webContents.executeJavaScript("window.mimirRequestAssetsLeave?.('save') ?? false").then(saved => {
        if (saved && !closingWindow.isDestroyed()) closingWindow.close()
        else quitFlow.cancelClose()
      }).catch(error => { quitFlow.cancelClose(); log.warn('[quit] 保存前关闭取消：', error) })
    } else quitFlow.cancelClose()
  })

  mainWindow.on('closed', () => {
    // 窗口销毁后其 IPC 目标已失效：中止该窗口名下所有会话的后台任务，避免残留任务空转写事件
    stopAllAgentTasks()
    if (windowRef.current === mainWindow) windowRef.current = null
    mainWindow = null
    // I6 维护交接：仅当已显式请求进入维护时推进状态机（否则保持 idle，走普通退出）。
    // 交接失败时状态机自身置 blocked，不放行第二写者；但窗口已关闭，必须回退到
    // 普通退出流程，否则会留下「无窗口且永不 quit」的僵尸进程。
    if (maintenanceHandoff && maintenanceHandoff.state === 'requested') {
      void maintenanceHandoff.windowClosed().catch(error => {
        log.warn('[maintenance] 交接未完成：', error)
        quitFlow.windowClosed()
      })
    } else {
      quitFlow.windowClosed()
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // 只放行 http(s)：`shell.openExternal` 会把任意 scheme 交给操作系统处理，
    // `file:` / 自定义 scheme 都可能在系统侧产生副作用。链接可能来自模型返回的
    // Markdown（渲染层渲染），因此必须与 `shell:openExternal` IPC 用同一套白名单。
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else {
      console.warn('[window] 拒绝打开非 http(s) 链接：', details.url)
    }
    return { action: 'deny' }
  })

  // Load the app
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    mainWindow = null
  }
})

app.on('activate', () => {
  // 未拿到单实例锁的第二个实例不得经 activate 旁路创建窗口（并因此初始化资源）。
  if (!singleInstanceLock) return
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(async () => {
  // 未拿到单实例锁的第二个实例：不初始化任何资源（尤其是资产库连接），直接退出。
  if (!singleInstanceLock) return

  // 注册 mimir-pdf:// 自定义协议：供文献库 iframe 内嵌阅读本地 PDF
  protocol.handle('mimir-pdf', (request) => {
    const url = new URL(request.url)
    const fileName = url.hostname === 'paper' ? url.pathname.replace(/^\//, '') : ''
    if (fileName === '') return new Response('Not Found', { status: 404 })
    const filePath = join(spaceRoot(), 'papers', fileName)
    if (!existsSync(filePath)) return new Response('Not Found', { status: 404 })
    return net.fetch(`file://${filePath}`)
  })

  // 注册 mimir-tex:// 自定义协议：iframe 内嵌预览 LaTeX 项目编译产物 main.pdf
  // URL 形态：mimir-tex://pdf/?p=<encodeURIComponent(绝对路径)>
  // 安全约束：仅放行「本会话登记过的论文项目目录」或「当前科研空间根目录内」的 PDF，
  // 避免渲染页被注入后借协议越权读取任意本地 PDF。
  protocol.handle('mimir-tex', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'pdf') return new Response('Not Found', { status: 404 })
      const filePath = url.searchParams.get('p') ?? ''
      if (filePath === '' || !filePath.toLowerCase().endsWith('.pdf')) {
        return new Response('Not Found', { status: 404 })
      }
      if (!existsSync(filePath)) return new Response('Not Found', { status: 404 })
      if (!isLatexPdfAllowed(filePath, spaceRoot())) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })

  // 注册 mimir-img:// 自定义协议：iframe/img 内联展示空间根 figures/ 下的图片
  // URL 形态：mimir-img://figures/<encodeURIComponent(fileName)>
  protocol.handle('mimir-img', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'figures') return new Response('Not Found', { status: 404 })
      const fileName = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const filePath = figureFilePath(fileName)
      if (filePath === null || !existsSync(filePath)) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })

  // ── I6 受保护初始化（普通启动装配）───────────────────────────────
  // ① 先占「注册表锁 + 当前空间锁」：写者会话在构造时校验本机磁盘并锁住 ~/.mimir。
  //    第二步 loadStore(session) 会以该会话为「空间切换保护」完成首次装载；
  //    初始化失败（含损坏 store）时 `transitionBlocked` 置位，后续写入一律拒绝——
  //    宁可只读，也不让空数据覆盖磁盘（详见 library/store.ts assertLayerWritable）。
  writerSession = new WorkspaceWriterSession(homedir(), assertWindowsLocalDisk)
  try {
    // 装载全局 store（首次会迁移旧版 userData/store.json → ~/.mimir/），
    // 并完成默认科研空间注册 / 恢复上次激活的空间。
    loadStore(writerSession)
  } catch (error) {
    // 受保护装载失败：立刻释放已占锁再退出，避免留下残锁让下次启动也起不来。
    try { writerSession.close() } catch { /* 关闭失败已在错误框提示用户手动检查 */ }
    writerSession = undefined
    throw error
  }
  // ② 装载完成后安装「任务保护」：把操作闸门接到 store 的写边界校验上。
  //    安装时会调用 gate.assertWritable()，gate 处于初始 accepting 态，通过。
  installWorkspaceOperationProtection(workspaceOperationGate)
  // ③ 在任何业务 IPC 注册**之前**包装 ipcMain.handle：
  //    - 普通通道统一经 gate.run(capture, fn) 跟踪，排空时拒绝新写入；
  //    - 批准/取消/终端关闭/维护入口为控制通道，不被排空阻塞；
  //    - workspaces:* 走 runControl（串行排空其它 IPC 后再执行空间变更）。
  installWorkspaceIpcGate(ipcMain, workspaceOperationGate, captureWorkspaceOperation, { timeoutMs: WORKSPACE_CONTROL_TIMEOUT_MS })

  // S2 API key 接缝：统一访问层经 provider 读设置页保存的 key（环境变量兜底）。
  // 不直读 process.env——打包后的 ESM bundle 里它会被构建期静态替换，运行时改值失效。
  setS2KeyProvider(() => {
    const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
    return typeof settings.s2ApiKey === 'string' ? settings.s2ApiKey : ''
  })

  // OpenAlex API key 接缝（免费 key，额度 ×10；未配置时回退 mailto 标识）。同 S2 理由。
  // paperSearch 与 oaLocation 各持一份同形 provider，装配同一读取逻辑。
  const readOpenAlexKey = (): string => {
    const settings = getStoreValue<Record<string, unknown>>('settings') ?? {}
    return typeof settings.openAlexApiKey === 'string' ? settings.openAlexApiKey : ''
  }
  setOpenAlexKeyProvider(readOpenAlexKey)
  oaLocationSetOpenAlexKeyProvider(readOpenAlexKey)

  // 上下文治理的 token 计数接缝：把真实 tokenizer 注入 contextManager（见 agent/contextManager.ts）。
  // 在进程启动时一次性注入，而不是在 Agent 初始化时——因为治理在「Agent 未初始化」时也可能被调用，
  // 且 token 口径属于进程级约定，不该随模型配置反复切换（countTokens 自身按模型名选词表）。
  // 用带 LRU 的版本：历史文本每轮都会被重复计数，缓存能省下热路径上的 BPE 开销。
  setTokenCounter(countTokensCached)

  // 会议截稿：首刷延迟 2s，之后每 6h 自动刷新
  startVenueDeadlineLoop()

  // Auto-initialize agent from saved settings
  await initAgentFromSettings()

  // IPC handler 只在进程启动时注册一次；渲染层窗口重建（macOS dock 重新激活）
  // 时通过 windowRef 指向最新窗口，避免 ipcMain.handle 重复注册崩溃。
  setupIpcHandlers(windowRef)

  // ── I6 维护交接入口 ────────────────────────────────────────────────
  // 状态机：渲染层请求 → 窗口关闭 → 排空在途任务 → 逐个关闭资源 → 启动维护窗口。
  // 任一步失败/超时即「阻断」，不放行第二写者；用户需确认资源退出后重试。
  // 各端口**复用已有**关闭接口，不新造生命周期（见文件末尾 shutdown 的同类清理）。
  maintenanceHandoff = new MaintenanceHandoff({
    gate: workspaceOperationGate,
    timeoutMs: WORKSPACE_HANDOFF_TIMEOUT_MS,
    cancelApprovals: async () => { resetApprovalSender() },
    stopProducers: async () => { stopAllAgentTasks() },
    closeMcp: async () => { assetsMcpAbort?.abort(); await (await assetsMcpStartup)?.close() },
    closeManagedProcesses: async () => { disposeIpcResources() },
    // 维护窗口需要独占资产库：先排空在途写入再真正放开 db 连接与文件锁。
    closeAssets: async () => { await assetsStoreManager.beforeSpaceSwitch(); await assetsStoreManager.close() },
    // 最终端口只**同步**安排重新拉起着维护模式并退出本进程；不得在此另启异步清理。
    launchMaintenance: () => {
      app.relaunch({ args: process.argv.slice(1).filter(arg => arg !== '--assets-mcp').concat('--workspace-maintenance') })
      app.exit(0)
    }
  })
  installWorkspaceMaintenanceHandler(ipcMain, () => maintenanceHandoff?.request(), event => {
    const win = mainWindow
    // 只信任当前普通窗口主框架：防止被注入的子框架/其它窗口旁路进入维护模式。
    return Boolean(win && !win.isDestroyed() && (event as { sender?: unknown }).sender === win.webContents)
  })

  createWindow()
  if (process.argv.includes('--assets-mcp')) {
    const approve = createExternalApproval({ window: () => mainWindow, currentScope: () => assetsStoreManager.context(),
      preview: request => externalApprovalPreview(request, scope => assetsStoreManager.getForRequest(scope)),
      show: (window, options) => dialog.showMessageBox(window, options) })
    assetsMcpAbort = new AbortController()
    assetsMcpStartup = startAssetsMcpHost({ userData: app.getPath('userData'), currentScope: () => assetsStoreManager.context(),
      signal: assetsMcpAbort.signal,
      // Electron launched with out/main/index.js reports out/main as getAppPath().
      // The compiled main's location is stable in both dev and build-entry launches.
      pipeArtifact: app.isPackaged ? { kind: 'packaged', resourcesPath: process.resourcesPath } : { kind: 'development', appRoot: join(__dirname, '../..') },
      context: scope => assetsStoreManager.getForRequest(scope), approve }).catch(error => {
      if (assetsMcpAbort?.signal.aborted) return null
      const safe = safeBrokerError(error)
      log.warn(`[assets-mcp] 启用失败：${safe.code}`)
      dialog.showErrorBox('外部资产 MCP 未启用', `${safe.message}\n桌面其它功能仍可使用。若有崩溃残留，请确认其它实例退出后再处理 assets-mcp/session.json。`)
      return null
    })
  }
}).catch((error: unknown) => {
  // 启动链兜底：协议注册 / store 装载 / IPC 注册 / 建窗任一步抛错都会落到这里。
  // 不静默 —— 弹框告知用户，并显式退出（否则会留下一个没有窗口的僵尸进程）。
  reportFatalError('Mimir 启动失败', error)
  app.quit()
})

/** 退出清理的最长等待：某个清理卡住时也要保证进程能退出（见应用规则「禁止静默挂起」）。 */
const SHUTDOWN_TIMEOUT_MS = 3_000

/**
 * 资产库写入排空的**独立**等待上限。
 *
 * 为什么单独计时：`beforeSpaceSwitch()` 要等在途资产写入落定，它与「停任务 / 关桥接」这类
 * 通用清理不是一类工作。此前它被塞进 `Promise.race(shutdown(), 3s)`，排空未完成就被
 * `app.quit()` 截断，可能带着在途写事务退出。这里给它自己的预算，并**先排空、再通用清理**。
 * 超时只告警：此时新写入已被切换态拒绝，不会再有新的提交进入。
 */
const ASSETS_DRAIN_TIMEOUT_MS = 30_000

/** 退出前排空资产库写入（独立预算；失败/超时只告警，不阻塞退出）。 */
async function drainAssetsBeforeQuit(): Promise<void> {
  let timedOut = false
  try {
    await Promise.race([
      assetsStoreManager.beforeSpaceSwitch(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true
          resolve()
        }, ASSETS_DRAIN_TIMEOUT_MS).unref?.()
      })
    ])
  } catch (error) {
    log.warn('[shutdown] 排空资产库写入失败：', error)
    return
  }
  // 超时是「可能带着在途事务退出」的场景，必须留痕；新写入此时已被切换态拒绝。
  if (timedOut) {
    log.warn(`[shutdown] 资产排空超时（${ASSETS_DRAIN_TIMEOUT_MS}ms），继续退出`)
  }
}

/**
 * 退出前的显式资源回收（复用各模块**已有**的关闭接口，不新造生命周期）：
 *
 * - `stopAllAgentTasks()`：中止所有在途 Agent 会话（各自持有 AbortController，
 *   也是 arXiv / 网页抓取等在途网络请求的取消源）；
 * - `resetApprovalSender()`：解绑批准通道并按 Fail-Closed 拒绝所有在途批准请求；
 * - `disposeIpcResources()`：终止存活的 PTY 子进程（node-pty 不随主进程退出）；
 * - `stopBridge()`：关闭本地桥接 HTTP 服务，释放端口；
 * - `shutdownOtel()`：把 OTel batch processor 缓冲区里的 span 刷给后端（不刷会丢最后几条 trace）。
 *
 * 未覆盖（如实记录）：会议截稿的刷新定时器已 `unref()`，不阻塞退出；
 * `library/arxiv` 的下载走 `AbortSignal.timeout`，随进程结束自然失效——两者都没有
 * 对外暴露 dispose，且都不会拖住退出，故未做额外处理。
 */
async function shutdown(): Promise<void> {
  // 资产库排空已由 before-quit 以**独立预算**先行完成（见 drainAssetsBeforeQuit），
  // 这里只做通用清理，共享 SHUTDOWN_TIMEOUT_MS 预算，避免被排空耗时挤掉。
  try {
    stopAllAgentTasks()
  } catch (error) {
    log.warn('[shutdown] 中止 Agent 任务失败：', error)
  }
  try {
    resetApprovalSender()
  } catch (error) {
    log.warn('[shutdown] 重置批准通道失败：', error)
  }
  try {
    disposeIpcResources()
  } catch (error) {
    log.warn('[shutdown] 回收 IPC 资源失败：', error)
  }
  try {
    await stopBridge()
  } catch (error) {
    log.warn('[shutdown] 停止桥接服务失败：', error)
  }
  try {
    await shutdownOtel()
  } catch (error) {
    log.warn('[shutdown] 停止可观测性上报失败：', error)
  }
}

const quitFlow = createQuitFlow({
  hasWindow: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
  closeWindow: () => mainWindow?.close(),
  quit: () => app.quit(),
  shutdown: async () => {
    assetsMcpAbort?.abort()
    // 先撤销外部请求和原生批准，再排空唯一writer；启动中的ACL操作也必须收口。
    try { await (await assetsMcpStartup)?.close() } catch { log.warn('[assets-mcp] 退出清理失败，凭据残留须确认后手动处理。') }
    // ① 先排空资产写入：独立预算，不被通用超时截断——保证在途事务落定后才继续退出。
    await drainAssetsBeforeQuit()
    // ② 再做通用清理：共享 3 秒预算，某个清理卡住时也要保证进程能退出。
    await Promise.race([
      shutdown(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.()
      })
    ])
    // ③ 最后释放写者会话（注册表锁 + 空间锁）：
    //    这一步**不能被 3 秒通用预算截断**——残留写锁会让下次启动直接失败；
    //    失败也不能吞掉：如实告警，提示用户手动检查 .mimir 下的残锁。
    try {
      writerSession?.close()
    } catch (error) {
      log.warn('[shutdown] 写者会话锁未完全释放，请检查 ~/.mimir 与科研空间 .mimir 下的残锁：', error)
    }
  }
})
app.on('before-quit', event => quitFlow.beforeQuit(event))
