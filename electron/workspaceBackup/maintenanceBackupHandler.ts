/**
 * 维护模式「逐空间完整备份」IPC 装配（I6 批次 3.5 · T04）。
 *
 * 职责：把批次 3.5 T03 的**编排服务层**（`runSpaceBackup`）接到维护窗口的 IPC 通道上，
 * 并**只向渲染层暴露必要字段**。本文件刻意把「纯逻辑」与「Electron 接线」分开（照
 * `maintenanceRetentionHandler.ts` / `maintenanceDoctorHandler.ts` / `maintenanceRestoreHandler.ts`
 * 的范式）：
 *
 * - `normalizeBackupRequest`：**纯函数**，零 IO、零 Electron 依赖，直接单测。它是渲染层回传
 *   未知值的**严格规范化**——只接受 `{ spaceId: string }` 形状，字段严格校验、**任何多余字段一律
 *   拒绝**（对齐 `maintenanceRetentionHandler.normalizeRetentionToken` 的严格风格，防渲染层塞路径）。
 * - `buildBackupHandler`：把纯函数 + 服务层装配成一个 `{ backup(request) }` 处理器，**不 import
 *   electron**（`runBackup` 经 deps 注入，缺省即真实 `runSpaceBackup`），因此可在不启动 Electron
 *   的情况下端到端单测。
 * - `registerBackupHandler`：唯一接触 `ipcMain` 的地方，由 `maintenanceMain` 调用。
 *
 * 纪律（逐条落实任务书 / 设计稿 §2 / §3）：
 * 1. **不 import electron**：所有 Electron 相关能力（sender 校验 / 通道注册）经形参注入。
 * 2. **不硬编码通道**：一律用 `WORKSPACE_BACKUP_CHANNELS.backupSpace`（批次 3 有一次硬编码
 *    教训——控制通道必须是单一事实源）。
 * 3. **trusted 前置**：非信任 sender 抛 `UNAUTHORIZED_SENDER`（与既有 `overview` / `restore` /
 *    `doctor` / `retention` handler 同口径）；备份是**写路径**，必须同源校验。
 * 4. **只收 spaceId，绝不收路径**（K4）：`backup` 入参是**渲染层传来的未知值**，必须**严格校验**
 *    为 `{ spaceId: string }`：`spaceId` 非空（trim 后）、长度有界（≤ 512）、无多余字段；不合法
 *    → 返回 `{ ok:false, code:'INVALID_REQUEST', detail }`，**绝不**把它当路径用（早退零副作用）。
 * 5. **单向裁剪**（§3）：结果**不含绝对路径 / home**（`runSpaceBackup` 已保证 `archiveName` 是
 *    basename，这里再确认不额外带出 `homeDir` 等）。
 * 6. **控制不可嵌套**（纪律 4 / K9）：本通道**不**经 `installWorkspaceIpcGate`；handler **只**
 *    直接调服务层（**绝不**调任何 `workspaces:*` IPC）。**不要**把本通道加进 `ipcGate.ts` 的
 *    `control` / `workspaceChanges` 集合。
 * 7. **绝不调用 `session.select()`**（本批关键裁决，见下）：维护会话在 backup 前**只**做健康检查
 *    （`assertUsable()`），与既有 `maintenanceRestoreHandler` 的形态**完全一致**。
 *    `WorkspaceWriterSession` 构造时**只**持 `registry.writer-lock`；每**空间**锁**只在**
 *    `select(root, maintenance)` 被调用时才取（`writerSession.ts:68/77`）。而 `defaultAcquireSpaceLock`
 *    取的路径是 `<root>/.mimir/workspace.writer-lock`——与 `prepareSelection` 里
 *    `acquireWorkspaceLock(canonical)` 取的**同址同名**。若在 backup 前调 `select()`，会话先持锁，
 *    `runSpaceBackup` 再取同一路径必然 `EEXIST` → **每次备份都 `LOCK_UNAVAILABLE`（自锁）**。
 *    因此本层**只**接受 `{ assertUsable }`，**绝不**接受 / 调用 `select`。
 */

import {
  WORKSPACE_BACKUP_CHANNELS,
  type MaintenanceBackupProgress,
  type MaintenanceBackupRequest,
  type MaintenanceBackupResult
} from '../../shared/workspaceBackupContracts'
import { runSpaceBackup, type BackupSpaceDeps } from './backupService'

/** `spaceId` 的长度上界（防超长垃圾串撑爆注册表查找 / 日志）。 */
const MAX_SPACE_ID_LENGTH = 512

/**
 * `buildBackupHandler` 的依赖（全部注入，便于单测；**不含任何 Electron 类型**）。
 *
 * - `homeDir` 必传（生产 = `homedir()`；测试 = 合成目录）。
 * - `session` 会话**健康检查**（**只有** `assertUsable()`；见上方纪律 7——**绝不要** `select`）。
 *   `undefined` 表示会话尚未就绪（窗口 `whenReady` 之前 / 已销毁）：此时任何备份都必须被拒
 *   （`LOCK_UNAVAILABLE`），**绝不**放行一次无锁写入。
 * - `runBackup` 可注入以隔离 IO / 测试：缺省即真实服务层 `runSpaceBackup`。
 * - `onProgress` 进度回调（生产 = `owner.webContents.send`；单测可注入以断言进度被上报）。
 * - `isPackaged` / `resourcesPath` / `appRoot` 原生绑定解析选项，透传给 `runSpaceBackup`。
 */
export interface BackupHandlerDeps {
  readonly producer?: import('../../shared/workspaceBackupMetadata').BackupProducer
  /** 注册表 home（生产 = `homedir()`；测试 = 合成目录）。 */
  readonly homeDir: string
  /** 会话健康检查（**只有** assertUsable；见纪律 7——绝不要 select）。 */
  readonly session: { assertUsable(): void } | undefined
  /**
   * 执行一次备份（缺省 = `runSpaceBackup`）。
   *
   * 注入点存在理由：单测可传入假实现精确断言「handler 是否用规范化后的入参调用服务层」，
   * 也可传入真服务层做端到端验证。
   */
  readonly runBackup?: (
    request: MaintenanceBackupRequest,
    deps: BackupSpaceDeps
  ) => Promise<MaintenanceBackupResult>
  /** 进度回调（生产 = `owner.webContents.send`；单测可注入以断言进度被上报）。 */
  readonly onProgress?: (progress: MaintenanceBackupProgress) => void
  /** 原生绑定解析透传（与 `runSpaceBackup` 的 `BackupSpaceDeps` 对齐）。 */
  readonly isPackaged?: boolean
  /** Electron `process.resourcesPath`（打包后必需）。 */
  readonly resourcesPath?: string
  /** 开发模式应用根（定位 `.native/` 缓存）；缺省 `process.cwd()`。 */
  readonly appRoot?: string
}

/** 备份处理器集合：`backup(request)`（**只收 spaceId**）执行一次逐空间备份（**永不抛**）。 */
export interface BackupHandler {
  /** 执行一次逐空间备份：入参为渲染层未知值，先经严格规范化再交给服务层（永不抛）。 */
  backup(request: unknown): Promise<MaintenanceBackupResult>
}

/**
 * 严格规范化渲染层回传的 `backup` 入参（K4 关键：**绝不信任渲染层**）。
 *
 * 只接受 `{ spaceId: string }` 形状：
 * - 顶层必须是**普通对象**（非 `null` / 非数组 / 非原始值）；
 * - **只允许** `spaceId` 一个字段——**任何多余字段一律拒绝**（对齐
 *   `maintenanceRetentionHandler.normalizeRetentionToken` 的严格风格：渲染层不该回传路径 /
 *   文件列表等额外信息，防渲染层塞 `path: '/evil'`）；
 * - `spaceId` 必须是**非空字符串**（trim 后非空）且长度 ≤ 512（`MAX_SPACE_ID_LENGTH`）。
 *
 * ⚠️ 本函数**只做形状规范化**，不做任何文件系统访问，也**不**把入参当路径用——真正「备份哪一个」
 * 一律由服务层（`runSpaceBackup`）据 `spaceId` 从只读注册表重解析（§1.1 步骤 ②）。
 *
 * @param input 渲染层传来的未知值。
 * @returns 合法时返回 `{ spaceId }`；否则返回 `null`（调用方据此早退 `INVALID_REQUEST`）。
 */
export function normalizeBackupRequest(input: unknown): MaintenanceBackupRequest | null {
  // 顶层必须是普通对象（拒 null / 数组 / 原始值）。
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null
  }
  const record = input as Record<string, unknown>

  // **任何多余字段一律拒绝**（只允许 spaceId 一个键）。
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'spaceId') {
    return null
  }

  const raw = record.spaceId
  // 必须是字符串。
  if (typeof raw !== 'string') {
    return null
  }
  // 非空（trim 后）且长度有界。
  if (raw.trim() === '') {
    return null
  }
  if (raw.length > MAX_SPACE_ID_LENGTH) {
    return null
  }

  return { spaceId: raw }
}

/**
 * 构造备份处理器（不 import electron，可在 node 下单测）。
 *
 * 流程（**严格早退，绝不无锁写入**）：
 * ① **会话健康检查**：`session` 为 `undefined` 或 `assertUsable()` 抛错 → 就地早退
 *    `{ ok:false, code:'LOCK_UNAVAILABLE' }`（**不调用服务层**，零副作用）。这是唯一的
 *    「健康闸门」；**绝不**调用 `session.select()`（见文件头纪律 7 的自锁理由）。
 * ② **严格规范化**（`normalizeBackupRequest`）：不合法 → 就地早退
 *    `{ ok:false, code:'INVALID_REQUEST' }`（**不调用服务层**，零副作用）。
 * ③ 合法 → 调 `runBackup(request, { home, onProgress, ... })`；**异常一律捕获**为
 *    `{ ok:false, code:'BACKUP_FAILED', detail }`（**绝不让异常穿到 IPC 层**）。
 *
 * @param deps 依赖（`homeDir` 必传；`runBackup` 可注入；缺省走真实服务层函数）。
 * @returns `{ backup }` 处理器。
 */
export function buildBackupHandler(deps: BackupHandlerDeps): BackupHandler {
  const runBackup = deps.runBackup ?? runSpaceBackup

  return {
    async backup(request: unknown): Promise<MaintenanceBackupResult> {
      // ① 会话健康检查 —— **只** assertUsable，**绝不** select（自锁红线）。
      //    `session === undefined`（未就绪）与 `assertUsable()` 抛错**统一**早退为
      //    LOCK_UNAVAILABLE，对齐既有 `maintenanceRestoreHandler` 的早退语义。
      try {
        if (deps.session === undefined) throw Error('维护会话尚未就绪。')
        deps.session.assertUsable()
      } catch {
        return {
          ok: false,
          code: 'LOCK_UNAVAILABLE',
          detail: '维护会话不可用，已拒绝备份（绝不无锁写入）。'
        }
      }

      // ② 严格规范化（K4）。不合法 → 就地拒绝，**绝不**调用服务层（零副作用早退）。
      const normalized = normalizeBackupRequest(request)
      if (normalized === null) {
        return {
          ok: false,
          code: 'INVALID_REQUEST',
          detail: '备份请求必须是形如 { spaceId } 的对象，且不含多余字段。'
        }
      }

      // ③ 合法 → 交给服务层。异常一律收敛为 BACKUP_FAILED，**绝不**外抛到 IPC 层。
      try {
        return await runBackup(normalized, {
          home: deps.homeDir,
          ...(deps.producer ? { producer: deps.producer } : {}),
          ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
          ...(deps.isPackaged !== undefined ? { isPackaged: deps.isPackaged } : {}),
          ...(deps.resourcesPath !== undefined ? { resourcesPath: deps.resourcesPath } : {}),
          ...(deps.appRoot !== undefined ? { appRoot: deps.appRoot } : {})
        })
      } catch (error) {
        if ((error as { code?: string })?.code === 'TASK_CLEANUP_FAILED') return { ok: false, code: 'TASK_CLEANUP_FAILED', detail: '备份资源收尾未完成，请检查维护记录；已发布资料保留。' }
        return {
          ok: false,
          code: 'BACKUP_FAILED',
          detail: '备份失败，未产出归档。'
        }
      }
    }
  }
}

/** `ipcMain.handle` 的最小形状（避免 import electron，便于单测直接复用签名）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/**
 * 注册备份 handler 到维护窗口的 `ipcMain`（**唯一接触 Electron 的地方**）。
 *
 * - 通道用 `WORKSPACE_BACKUP_CHANNELS.backupSpace`（与 preload 硬编码字符串一致）；
 *   **绝不硬编码通道名**。
 * - sender 校验复用维护窗口的 `trusted(event)`：不通过即 `throw Error('UNAUTHORIZED_SENDER')`
 *   —— 与既有 `overview` / `restore` / `doctor` / `retention` handler 同口径；备份是**写路径**，
 *   必须同源校验。
 *
 * ⚠️ 纪律「控制不可嵌套」：本通道**不**经 `installWorkspaceIpcGate`；备份 handler **只**调服务层
 * （`runSpaceBackup`），**绝不**调任何 `workspaces:*` IPC。**不要**把本通道加进 `ipcGate.ts` 的
 * `control` / `workspaceChanges` 集合（K9）。
 *
 * @param ipc 生产 = `ipcMain`（`electron`）；单测可传假实现。
 * @param trusted sender 校验（生产 = `maintenanceMain` 里的 `trusted`）。
 * @param handler 由 `buildBackupHandler` 构造。
 */
export function registerBackupHandler(
  ipc: IpcMainLike,
  trusted: (event: unknown) => boolean,
  handler: BackupHandler
): void {
  ipc.handle(
    WORKSPACE_BACKUP_CHANNELS.backupSpace,
    (event: unknown, request: unknown): Promise<MaintenanceBackupResult> => {
      if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
      // 渲染层回传的是**未知值**：转交 `handler.backup` 做严格规范化（K4）。
      return handler.backup(request)
    }
  )
}
