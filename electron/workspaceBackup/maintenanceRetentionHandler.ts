/**
 * 维护模式「备份保留」IPC 装配（I6 批次 5 · T04）。
 *
 * 职责：把服务层的**只读预览**（`buildRetentionPreview`）与**显式清理**
 * （`applyRetention`）接到维护窗口的 IPC 通道上，并**只向渲染层暴露必要字段**。
 * 本文件刻意把「纯逻辑」与「Electron 接线」分开（照 `maintenanceDoctorHandler.ts` /
 * `maintenanceRestoreHandler.ts` 的范式）：
 *
 * - `normalizeRetentionToken`：**纯函数**，零 IO、零 Electron 依赖，直接单测。它是
 *   渲染层回传未知值的**严格规范化**——只接受 `{ confirmToken: string }` 形状，字段
 *   严格校验、**任何多余字段一律拒绝**（对齐 `maintenanceRestoreHandler.normalizeRestoreRequest`
 *   的严格风格）。
 * - `buildRetentionHandler`：把纯函数 + 服务层装配成一个 `{ preview, apply }` 处理器，
 *   **不 import electron**（`buildPreview` / `applyRetention` 经 deps 注入），因此可在不启动
 *   Electron 的情况下端到端单测。
 * - `registerRetentionHandler`：唯一接触 `ipcMain` 的地方，由 `maintenanceMain` 调用。
 *
 * 纪律（逐条落实任务书 / 设计稿 §2 / §3.2 / 风险表 K2 / K3 / K9）：
 * 1. **不 import electron**：所有 Electron 相关能力（sender 校验 / 通道注册）经形参注入。
 * 2. **不硬编码通道**：一律用 `WORKSPACE_BACKUP_CHANNELS.retentionPreview` /
 *    `.retentionApply`（批次 3 有一次硬编码教训——控制通道必须是单一事实源）。
 * 3. **trusted 前置**：非信任 sender 抛 `UNAUTHORIZED_SENDER`（与既有 `overview` /
 *    `restore` / `doctor` handler 同口径）。
 * 4. **只收 token，绝不收路径**（K2）：`apply` 入参是**渲染层传来的未知值**，必须**严格校验**
 *    为 `{ confirmToken: string }`：`confirmToken` 非空、长度有界（≤ 512）、无多余字段；
 *    不合法 → 返回 `{ ok:false, code:'INVALID_REQUEST', detail }`，**绝不**把它当路径或
 *    文件列表用（早退零副作用）。
 * 5. **单向裁剪**（§3.2）：预览结果**不含绝对路径**（`retentionService` 已保证，这里再确认
 *    不额外带出 `deps.home` 等）。
 * 6. **控制不可嵌套**（纪律 4 / K9）：本通道**不**经 `installWorkspaceIpcGate`；两 handler
 *    直接调服务层（**绝不**调任何 `workspaces:*` IPC）。**不要**把本通道加进 `ipcGate.ts` 的
 *    `control` / `workspaceChanges` 集合。
 */

import {
  WORKSPACE_BACKUP_CHANNELS,
  type MaintenanceRetentionPreview,
  type MaintenanceRetentionResult
} from '../../shared/workspaceBackupContracts'
import {
  buildRetentionPreview,
  applyRetention,
  type RetentionDeps
} from './retentionService'

/** `confirmToken` 的长度上界（防超长垃圾串撑爆摘要计算 / 日志）。 */
const MAX_CONFIRM_TOKEN_LENGTH = 512

/**
 * `buildRetentionHandler` 的依赖（全部注入，便于单测；**不含任何 Electron 类型**）。
 *
 * - `homeDir` 必传（生产 = `homedir()`；测试 = 合成目录）。
 * - `buildPreview` / `applyRetention` 可注入以隔离 IO / 测试：缺省即真实服务层函数
 *   （`buildRetentionPreview` / `applyRetention`），`home = deps.homeDir`。
 */
export interface RetentionHandlerDeps {
  /** 注册表 home（生产 = `homedir()`；测试 = 合成目录）。 */
  readonly homeDir: string
  /** 可注入以隔离 IO / 测试：缺省 = `buildRetentionPreview`（只读预览）。 */
  readonly buildPreview?: (deps: { home: string }) => MaintenanceRetentionPreview
  /** 可注入以隔离 IO / 测试：缺省 = `applyRetention`（显式清理，只收 token）。 */
  readonly applyRetention?: (token: string, deps: { home: string }) => MaintenanceRetentionResult
}

/** 保留处理器集合：`preview()` 只读预览；`apply(token)` 显式清理（**只收 token**）。 */
export interface RetentionHandler {
  /** 运行一次只读预览，返回**脱敏**视图（永不抛）。 */
  preview(): Promise<MaintenanceRetentionPreview>
  /** 显式清理：入参为渲染层未知值，先经严格规范化再交给服务层（永不抛）。 */
  apply(token: unknown): Promise<MaintenanceRetentionResult>
}

/**
 * 严格规范化渲染层回传的 `apply` 入参（K2 关键：**绝不信任渲染层**）。
 *
 * 只接受 `{ confirmToken: string }` 形状：
 * - 顶层必须是**普通对象**（非 `null` / 非数组）；
 * - **只允许** `confirmToken` 一个字段——**任何多余字段一律拒绝**（对齐
 *   `maintenanceRestoreHandler.normalizeRestoreRequest` 的严格风格：渲染层不该回传路径 /
 *   文件列表等额外信息）；
 * - `confirmToken` 必须是**非空字符串**且长度 ≤ 512（`MAX_CONFIRM_TOKEN_LENGTH`）。
 *
 * ⚠️ 本函数**只做形状规范化**，不做任何文件系统访问，也**不**把入参当路径 / 文件列表用——
 * 真正「删除哪一个」一律由服务层据 token 重算（§2.2 步骤 ②）。
 *
 * @param value 渲染层传来的未知值。
 * @returns 合法时返回 token 字符串；否则返回 `{ detail }` 说明拒绝原因。
 */
export function normalizeRetentionToken(
  value: unknown
): { ok: true; token: string } | { ok: false; detail: string } {
  // 顶层必须是普通对象（拒 null / 数组 / 原始值）。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, detail: '确认请求必须是形如 { confirmToken } 的对象。' }
  }
  const record = value as Record<string, unknown>

  // **任何多余字段一律拒绝**（只允许 confirmToken 一个键）。
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'confirmToken') {
    return { ok: false, detail: '确认请求只接受 confirmToken 一个字段。' }
  }

  const confirmToken = record.confirmToken
  // 必须是字符串。
  if (typeof confirmToken !== 'string') {
    return { ok: false, detail: 'confirmToken 必须是字符串。' }
  }
  // 非空（trim 后）且长度有界。
  const trimmed = confirmToken
  if (trimmed === '') {
    return { ok: false, detail: 'confirmToken 不能为空。' }
  }
  if (trimmed.length > MAX_CONFIRM_TOKEN_LENGTH) {
    return { ok: false, detail: 'confirmToken 长度超出上界。' }
  }

  return { ok: true, token: trimmed }
}

/**
 * 构造保留处理器（不 import electron，可在 node 下单测）。
 *
 * `preview()`：调 `buildPreview({ home })` 返回脱敏视图。只读，不取锁、不建目录、不写文件。
 *
 * `apply(token)`：**先严格规范化**（`normalizeRetentionToken`）→ 不合法**就地早退**
 * `INVALID_REQUEST`（**不调用服务层**，零副作用）→ 合法则调
 * `applyRetention(token, { home })`。服务层内部再据 token 重算候选（绝不信渲染层）。
 *
 * @param deps 依赖（`homeDir` 必传；其余可注入；缺省走真实服务层函数）。
 * @returns `{ preview, apply }` 处理器。
 */
export function buildRetentionHandler(deps: RetentionHandlerDeps): RetentionHandler {
  const buildPreview = deps.buildPreview ?? buildRetentionPreview
  const apply = deps.applyRetention ?? applyRetention

  return {
    async preview(): Promise<MaintenanceRetentionPreview> {
      // 只读：`buildRetentionPreview` 内部保证「不取锁、不建目录、不写文件」。
      return buildPreview({ home: deps.homeDir })
    },

    async apply(token: unknown): Promise<MaintenanceRetentionResult> {
      // ① 严格规范化（K2）。不合法 → 就地拒绝，**绝不**调用服务层（零副作用早退）。
      const normalized = normalizeRetentionToken(token)
      if (!normalized.ok) {
        return { ok: false, code: 'INVALID_REQUEST', detail: normalized.detail }
      }
      // ② 合法 → 交给服务层（其内部据 token 重算候选并校验，渲染层无法指定删除目标）。
      return apply(normalized.token, { home: deps.homeDir })
    }
  }
}

/** `ipcMain.handle` 的最小形状（避免 import electron，便于单测直接复用签名）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/**
 * 注册保留预览 / 清理 handler 到维护窗口的 `ipcMain`（**唯一接触 Electron 的地方之一**）。
 *
 * - `retentionPreview` / `retentionApply` 通道用 `WORKSPACE_BACKUP_CHANNELS.*`（与 preload
 *   硬编码字符串一致）；**绝不硬编码通道名**。
 * - sender 校验复用维护窗口的 `trusted(event)`：不通过即 `throw Error('UNAUTHORIZED_SENDER')`
 *   —— 与既有 `overview` / `restore` / `doctor` handler 同口径；清理是**写路径**，必须同源校验。
 *
 * ⚠️ 纪律「控制不可嵌套」：本通道**不**经 `installWorkspaceIpcGate`；预览是**只读**、
 * 清理**只**经服务层（绝不调任何 `workspaces:*` IPC）。**不要**把本通道加进 `ipcGate.ts`
 * 的 `control` / `workspaceChanges` 集合（K9）。
 *
 * @param ipc 生产 = `ipcMain`（`electron`）；单测可传假实现。
 * @param trusted sender 校验（生产 = `maintenanceMain` 里的 `trusted`）。
 * @param handler 由 `buildRetentionHandler` 构造。
 */
export function registerRetentionHandler(
  ipc: IpcMainLike,
  trusted: (event: unknown) => boolean,
  handler: RetentionHandler
): void {
  ipc.handle(
    WORKSPACE_BACKUP_CHANNELS.retentionPreview,
    (event: unknown): Promise<MaintenanceRetentionPreview> => {
      if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
      // 预览为最保守形态（无入参）：主进程自行推导 home，绝不接受渲染层传入值。
      return handler.preview()
    }
  )

  ipc.handle(
    WORKSPACE_BACKUP_CHANNELS.retentionApply,
    (event: unknown, request: unknown): Promise<MaintenanceRetentionResult> => {
      if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
      // 渲染层回传的是**未知值**：转交 `handler.apply` 做严格规范化（K2）。
      return handler.apply(request)
    }
  )
}
