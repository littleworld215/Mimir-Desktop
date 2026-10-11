/**
 * 维护模式恢复 IPC 装配（I6 批次 3 · T05 收口）。
 *
 * 职责：把 `restoreMain.runMaintenanceRestore`（服务层）接到维护窗口的 IPC 通道上，
 * 并**只向渲染层暴露必要字段**。本文件刻意把「纯逻辑」与「Electron 接线」分开：
 *
 * - `normalizeRestoreRequest` / `toRestoreResult`：**纯函数**，零 IO、零 Electron 依赖，
 *   直接单测（`test/unit/workspaceBackup/maintenanceRestoreIpc.test.ts`）。
 * - `buildRestoreHandler`：把纯函数 + 服务层装配成一个 `(request) => promise` 的处理器，
 *   **不 import electron**（`session` 经 deps 注入），因此可在不启动 Electron 的情况下端到端单测。
 * - `registerRestoreHandler`：唯一接触 `ipcMain` 的地方，由 `maintenanceMain` 调用。
 *
 * 纪律（逐条落实任务书）：
 * 1. **绝不信任渲染层拼的路径**（§4.2 S7）：`targetRoot` 一律 `path.resolve`，字符串 trim；
 *    空值就地拒绝，**不取锁、不建目录**。
 * 2. **控制不可嵌套**（纪律 4）：本层**绝不**调用任何 `workspaces:*` IPC；它直接调服务层，
 *    且本通道**不**被 `installWorkspaceIpcGate` 包装（见 `ipcGate.ts` 注释）。
 * 3. **不泄漏本机路径**：`toRestoreResult` 只映射用户可见字段，**绝不**带出 `cleanup` /
 *    `remap` / 暂存根路径。
 * 4. **失败不自行删路径**：本层只映射 `RestoreOutcome`，不触碰文件系统；回收与否交 UI 决定。
 */

import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  runMaintenanceRestore,
  type MaintenanceRestoreDeps,
  type RestoreRequest
} from './restoreMain'
import { acquireMigratableWriterLock } from './operationGate'
import type { RestoreOutcome } from './restoreRunner'
import type { ManifestEntry } from './manifest'
import type {
  MaintenanceRestoreRequest,
  MaintenanceRestoreResult
} from '../../shared/workspaceBackupContracts'

/**
 * 规范化渲染层回传的请求（§4.2 S7：**绝不信任**渲染层拼的路径）。
 *
 * - `targetRoot` → `path.resolve` 成绝对路径（消除 `..`、相对段、混合分隔符）；
 * - `archivePath` / `spaceName` → `trim`（去除首尾空白）。
 *
 * 规范化**只做归一**，不做存在性/合法性判断：那些留给服务层（`runMaintenanceRestore`
 * 的步骤 ①/②），以保证「早退零副作用」只有**一处**实现。
 *
 * @returns 规范化后的请求；若关键字段为空则为 `null`（调用方据此早退 `INVALID_TARGET`）。
 */
export function normalizeRestoreRequest(request: MaintenanceRestoreRequest): RestoreRequest | null {
  // 渲染层可能给出非字符串（版本错配 / 恶意构造）：一律当空处理，走 INVALID_TARGET。
  const archivePath = typeof request?.archivePath === 'string' ? request.archivePath.trim() : ''
  const spaceName = typeof request?.spaceName === 'string' ? request.spaceName.trim() : ''
  const targetRaw = typeof request?.targetRoot === 'string' ? request.targetRoot.trim() : ''
  if (archivePath === '' || spaceName === '' || targetRaw === '') return null
  return { archivePath, targetRoot: resolve(targetRaw), spaceName }
}

/** 维护窗口可见的失败码（与服务层 `RestoreErrorCode` 交集；其余透传字符串）。 */
function failureCode(outcome: RestoreOutcome): string {
  return outcome.failure?.code ?? 'INTERNAL'
}

/**
 * 把服务层 `RestoreOutcome` **映射**成渲染层可安全消费的 `MaintenanceRestoreResult`。
 *
 * ⚠️ 映射是**单向裁剪**：只取必要字段。
 * - 成功：取 `result` 的 `spaceId/name/root/entries/totalBytes` + `remap.rewritten.length`；
 * - 失败：取 `failure.code/detail/retryable`；
 * - **绝不**带出 `cleanup`（暂存根 / 已发布目标的本机绝对路径）、`remap`（全量审计报告）、
 *   `finishedAt`、`stagingRoot` 等内部概念。
 *
 * 防御性：若 `stage==='done'` 但 `result` 缺失（不该发生），降级为 `INTERNAL` 失败，
 * **绝不**谎报成功（对齐「不得谎报 done」的一贯纪律）。
 */
export function toRestoreResult(outcome: RestoreOutcome): MaintenanceRestoreResult {
  if (outcome.stage === 'done' && outcome.result !== null) {
    const result = outcome.result
    return {
      ok: true,
      spaceId: result.spaceId,
      name: result.name,
      root: result.root,
      entries: result.entries,
      totalBytes: result.totalBytes,
      // T03 只把「确实改写」的记录放进 `rewritten`；`remap` 缺失时为 0。
      rewritten: outcome.remap?.rewritten?.length ?? 0
    }
  }
  if (outcome.failure !== null) {
    return {
      ok: false,
      code: failureCode(outcome),
      detail: outcome.failure.detail,
      retryable: outcome.failure.retryable
    }
  }
  // 理论不可达：既非 done 也无 failure。给一条无信息量的安全失败，不泄漏任何路径。
  return { ok: false, code: 'INTERNAL', detail: '恢复未产生结果。', retryable: false }
}

/** 生产用的「暂存根内取可迁移写锁」获取器（`restoreMain.test.ts` 的 `realLockFactory` 同逻辑）。 */
export function acquireStagingLock(stagingRoot: string): { release(): void; migrate?(next: string): void } {
  // `acquireMigratableWriterLock` 内部要 lstat/realpath 锁的父目录，故 `.mimir` 必须先存在。
  const mimirDir = join(stagingRoot, '.mimir')
  mkdirSync(mimirDir, { recursive: true })
  return acquireMigratableWriterLock(join(mimirDir, 'workspace.writer-lock'), stagingRoot)
}

/** `buildRestoreHandler` 的依赖（全部注入，便于单测；**不含任何 Electron 类型**）。 */
export interface RestoreHandlerDeps {
  /**
   * 当前维护会话的**健康检查**（`maintenanceMain` 的模块级 `session`）。
   *
   * `undefined` 表示会话尚未就绪（窗口 `whenReady` 之前 / 已销毁）：此时任何恢复
   * 都必须被拒（`LOCK_UNAVAILABLE`），**绝不**放行一次无锁写入。
   */
  readonly session: { assertUsable(): void } | undefined
  /** 注册表 home（生产 = `homedir()`；测试 = 合成目录）。 */
  readonly homeDir: string
  /**
   * 执行一次恢复（缺省 = `runMaintenanceRestore`）。
   *
   * 注入点存在理由：单测可传入假实现精确断言「handler 是否用规范化后的入参调用服务层」，
   * 也可传入真服务层做端到端验证。
   */
  readonly run?: typeof runMaintenanceRestore
  /**
   * 取锁器（缺省 = `acquireStagingLock`）。注入点供单测替换，避免真取锁副作用。
   */
  readonly lockStagingRoot?: MaintenanceRestoreDeps['lockStagingRoot']
  /** 归档清单读取（缺省 = 服务层默认 `readArchiveManifest`）。透传以便单测注入。 */
  readonly readManifest?: (archivePath: string) => Promise<{ sourceRoot?: string; entries: ManifestEntry[] }>
  /** 进度回调（生产 = `owner.webContents.send`；单测可注入以断言进度被上报）。 */
  readonly onProgress?: MaintenanceRestoreDeps['onProgress']
}

/** 恢复处理器：`(request) => promise`，**永不抛**（失败以 `{ ok: false }` 表达）。 */
export type RestoreHandler = (request: MaintenanceRestoreRequest) => Promise<MaintenanceRestoreResult>

/**
 * 构造恢复处理器（不 import electron，可在 node 下单测）。
 *
 * 流程：**规范化 → 空值早退（不取锁）→ 构造 deps → 调服务层 → 映射结果**。
 *
 * 「控制不可嵌套」纪律的落点：本处理器**只**调 `deps.run`（= `runMaintenanceRestore`），
 * 后者直接直连真实模块，**绝不**经任何 `workspaces:*` IPC。故恢复永远只有**一层**串行，
 * 不会被 `runControl` 再包一层而死锁。
 */
export function buildRestoreHandler(deps: RestoreHandlerDeps): RestoreHandler {
  const run = deps.run ?? runMaintenanceRestore
  const lockStagingRoot = deps.lockStagingRoot ?? acquireStagingLock

  return async (request: MaintenanceRestoreRequest): Promise<MaintenanceRestoreResult> => {
    // ① 规范化（§4.2 S7）。空值就地拒绝 —— 注意：此时**尚未取锁、未建任何目录**。
    const normalized = normalizeRestoreRequest(request)
    if (normalized === null) {
      return {
        ok: false,
        code: 'INVALID_TARGET',
        detail: '请填写新空间名与目标目录绝对路径。',
        retryable: false
      }
    }

    // ② 会话健康检查在**构造 deps 时**求值：`session === undefined` 直接抛，
    //    由服务层的 `deps.session.assertUsable()` 捕获为 `LOCK_UNAVAILABLE`（与既有早退语义一致）。
    const session = deps.session ?? {
      assertUsable: (): void => {
        throw Error('维护会话尚未就绪。')
      }
    }

    const restoreDeps: MaintenanceRestoreDeps = {
      session,
      homeDir: deps.homeDir,
      // 生产：先建 `<staging>/.mimir` 再取可迁移锁（随发布 rename 迁到目标）。
      lockStagingRoot,
      ...(deps.readManifest !== undefined ? { readManifest: deps.readManifest } : {}),
      ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {})
    }

    // ③ 调服务层（永不抛）。任何设计外逃逸都归一为 INTERNAL 失败，绝不让异常冒到 IPC 层。
    let outcome: RestoreOutcome
    try {
      outcome = await run(normalized, restoreDeps)
    } catch (error) {
      return {
        ok: false,
        code: 'INTERNAL',
        detail: (error as Error)?.message ?? '恢复过程中发生未知错误。',
        retryable: false
      }
    }

    // ④ 映射为渲染层安全结果（裁剪掉 cleanup / remap 等本机路径细节）。
    return toRestoreResult(outcome)
  }
}

/** `ipcMain.handle` 的最小形状（避免 import electron，便于单测直接复用签名）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/**
 * 注册恢复 handler 到维护窗口的 `ipcMain`（**唯一接触 Electron 的地方**）。
 *
 * - 通道用 `WORKSPACE_BACKUP_CHANNELS.restore`（与 preload 硬编码字符串一致）；
 * - sender 校验复用维护窗口的 `trusted(event)`：不通过即 `throw Error('UNAUTHORIZED_SENDER')`
 *   —— 与既有 `overview` handler 同口径，恢复是最敏感的写路径，必须同源校验。
 *
 * @param ipc 生产 = `ipcMain`（`electron`）；单测可传假实现。
 * @param trusted sender 校验（生产 = `maintenanceMain` 里的 `trusted`）。
 * @param handler 由 `buildRestoreHandler` 构造。
 */
export function registerRestoreHandler(
  ipc: IpcMainLike,
  trusted: (event: unknown) => boolean,
  handler: RestoreHandler
): void {
  ipc.handle('workspaceBackup:restore', (event: unknown, request: unknown): Promise<MaintenanceRestoreResult> => {
    if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
    // 渲染层请求未经信任：`buildRestoreHandler` 内部会再规范化（此处只做类型收窄）。
    return handler(request as MaintenanceRestoreRequest)
  })
}
