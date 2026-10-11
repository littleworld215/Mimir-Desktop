/**
 * 维护窗口（I6 备份/恢复）与渲染层共享的契约。
 *
 * 兼容纪律：本文件同时被 `electron/workspaceBackup/maintenanceMain.ts`（主进程）
 * 与 `src/renderer/maintenance.tsx`（沙箱渲染层）加载。**新增字段一律可选**，
 * 不改既有字段的形状与含义——渲染层可能是旧版本、主进程可能是新版本，双向都要能解析。
 */

/** 维护窗口 IPC 通道。 */
export const WORKSPACE_BACKUP_CHANNELS = {
  overview: 'workspaceBackup:overview',
  /**
   * 恢复（批次 3 · T05 收口）。
   *
   * ⚠️ 通道名**必须**与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**：
   * 本通道由 `maintenanceMain` 在**维护模式**下用**独立** `ipcMain` 注册，从不经过
   * `installWorkspaceIpcGate`。恢复自身已持有写者会话并按纪律 4「控制不可嵌套」自串行，
   * 若被 `runControl` 再包一层即死锁（见 `ipcGate.ts` 里 `control` 集合上方的注释）。
   */
  restore: 'workspaceBackup:restore',
  /**
   * 恢复进度（可选增强；主进程 `webContents.send` → 渲染层 `ipcRenderer.on`）。
   *
   * 与 `restore` invoke 通道**解耦**：进度是最佳努力的可观测性，丢一两条不影响恢复结果。
   * 之所以走**独立事件**而非 invoke 返回值：invoke 只能给一个终值，而进度可能在一次
   * 恢复里多次到达。通道名进常量表是为了与 preload 的硬编码字符串保持单一事实源。
   */
  restoreProgress: 'workspaceBackup:restoreProgress'
} as const

/**
 * 维护窗口初始清单。
 *
 * `spaces` 自批次 1/2 起就是**只读空间名清单**（`readRegistryOverview` 口径）。
 * 批次 3 追加 `archives`（可选）：用户可恢复的归档候选。
 * 旧渲染层不认识 `archives` 时会忽略它，行为与之前完全一致。
 */
export interface MaintenanceArchiveCandidate {
  /** 归档绝对路径（**仅供展示**；恢复时由主进程重新规范化，不用渲染层回传的字符串）。 */
  readonly path: string
  /** 展示用文件名。 */
  readonly name: string
  readonly bytes: number
  readonly modifiedAt: string
  /** 该归档是否含可推导的旧空间根（能否把论文路径自动改到新空间）。 */
  readonly remappable: boolean
}

export type MaintenanceOverview =
  | {
      ok: true
      spaces: Array<{ id: string; name: string }>
      /** 可选：可恢复的归档候选（**只做展示与选择**，恢复动作由后续版本开放）。 */
      archives?: MaintenanceArchiveCandidate[]
    }
  | { ok: false; code: 'REGISTRY_INVALID' }

/**
 * 渲染层可见的维护窗口 API。
 *
 * 批次 3 · T05 收口后新增 `restore`：恢复的**写入路径**（解压 / 发布 / 注册）仍由主进程
 * 在维护模式下以自身持有的写者会话执行，不通过本桥暴露任意路径拼接能力（设计 §4.2 S7）。
 * 渲染层回传的 `archivePath` / `targetRoot` / `spaceName` **只作输入**：主进程必须自行
 * `path.resolve` 规范化并重新校验，**绝不**信任渲染层拼好的路径。
 */
export interface WorkspaceBackupMaintenanceApi {
  overview(): Promise<MaintenanceOverview>
  /**
   * 把一份归档恢复成一个**新**科研空间。
   *
   * 可选（`?`）以保持向后兼容：旧渲染层不认识它；同理旧主进程不提供它时，
   * 新渲染层调用的 `window.workspaceBackupMaintenance.restore` 会是 `undefined`,
   * 渲染层必须先判存在再调用。
   */
  restore?(request: MaintenanceRestoreRequest): Promise<MaintenanceRestoreResult>
  /**
   * 订阅恢复进度（可选增强）。
   *
   * 返回一个取消订阅函数。渲染层可据此显示「正在解压 / 正在校验…」等阶段文案。
   * 与 `restore` 一样为**可选**：旧版本不提供时渲染层应优雅降级（不显示进度）。
   */
  onRestoreProgress?(listener: (progress: MaintenanceRestoreProgress) => void): () => void
}

/** 恢复进度上报（主进程 → 渲染层；**只含阶段与文案，不含任何本机路径**）。 */
export interface MaintenanceRestoreProgress {
  /** 阶段标识（`inspecting` / `extracting` / `verifying` / `publishing` / `registering` 等）。 */
  readonly stage: string
  /** 面向用户的阶段说明。 */
  readonly detail: string
}

/**
 * 恢复请求（渲染层 → 主进程）。
 *
 * ⚠️ **全部字段都只作输入**，主进程必须重新规范化：
 * - `targetRoot` 用 `path.resolve` 成绝对路径；
 * - `spaceName` `trim`；`archivePath` `trim`；
 * - 空值一律在主进程就地拒绝（`INVALID_TARGET`），**不取锁、不建目录**。
 *
 * 刻意**不包含** `homeDir` / `oldRoot` / staging token 等服务层内部概念——它们由主进程
 * 从自身运行环境推导（`homedir()` + 归档清单），渲染层无法也不得影响（§4.2 S7）。
 */
export interface MaintenanceRestoreRequest {
  /** 归档绝对路径（字符串**只作输入**，主进程重新规范化）。 */
  archivePath: string
  /** 新空间根绝对路径（字符串**只作输入**，主进程 `path.resolve` 后使用）。 */
  targetRoot: string
  /** 新空间名（登记用）。 */
  spaceName: string
}

/**
 * 恢复结果（主进程 → 渲染层）：**可被沙箱渲染层安全消费**。
 *
 * ⚠️ **绝不**把服务层的 `RestoreOutcome` 原样暴露：它含 `cleanup`（暂存根 / 已发布目标
 * 的本机绝对路径）与 `remap`（T03 全量审计报告），两者都是**本机路径细节**，
 * 泄漏给渲染层既无必要、也扩大暴露面。这里只映射用户可见的必要字段。
 */
export type MaintenanceRestoreResult =
  | {
      ok: true
      /** 新空间 id（新 UUID）。 */
      spaceId: string
      /** 新空间名。 */
      name: string
      /** 新空间根（绝对）。 */
      root: string
      /** 归档内条目数。 */
      entries: number
      /** 归档内文件展开总字节。 */
      totalBytes: number
      /** T03 自动改写的关联路径条数（用户可见的「改写 M 条」）。 */
      rewritten: number
    }
  | {
      ok: false
      /** 恢复错误码（SCREAMING_SNAKE；渲染层据此给出人话文案）。 */
      code: string
      /** 面向用户的补充说明（**不含**本机暂存路径 / 凭据）。 */
      detail: string
      /** 是否可通过「重试」再次执行（`inspecting` 失败需换归档 → false）。 */
      retryable: boolean
    }
