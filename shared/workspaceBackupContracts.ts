/**
 * 维护窗口（I6 备份/恢复）与渲染层共享的契约。
 *
 * 兼容纪律：本文件同时被 `electron/workspaceBackup/maintenanceMain.ts`（主进程）
 * 与 `src/renderer/maintenance.tsx`（沙箱渲染层）加载。**新增字段一律可选**，
 * 不改既有字段的形状与含义——渲染层可能是旧版本、主进程可能是新版本，双向都要能解析。
 */

/** 普通窗口只允许请求交接；不暴露维护读写或任意路径。ok仅表示已请求。 */
export const WORKSPACE_MAINTENANCE_ENTRY_CHANNEL = 'workspaceBackup:enterMaintenance'
export interface WorkspaceMaintenanceEntryApi { enterMaintenance(): Promise<{ ok: true }> }

/** 维护窗口 IPC 通道。 */
export const WORKSPACE_BACKUP_CHANNELS = {
  taskStatus: 'workspaceBackup:taskStatus',
  taskCancel: 'workspaceBackup:taskCancel',
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
  restoreProgress: 'workspaceBackup:restoreProgress',
  /**
   * 只读自检（doctor，I6 批次 4 · T01）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**：本通道由 `maintenanceMain`
   * 在维护模式下用**独立** `ipcMain` 注册，从不经过 `installWorkspaceIpcGate`（控制不可嵌套）。
   * 语义：**纯只读**。自检不取锁、不建目录、不写任何文件，结果只陈述技术事实（对齐 D-038）。
   */
  doctor: 'workspaceBackup:doctor',
  /**
   * 自检进度（I6 批次 4 · T01；主进程 `webContents.send` → 渲染层 `ipcRenderer.on`）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**（同上，独立 `ipcMain`）。
   * 语义：**纯信号/可观测性**——最佳努力，丢一两条不影响自检结果；`detail` 不含本机绝对路径。
   */
  doctorProgress: 'workspaceBackup:doctorProgress',
  /**
   * 取消自检（I6 批次 4 · T01）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**（同上，独立 `ipcMain`）。
   * 语义：**只读取消**——自检无副作用，取消 = 停止继续跑剩余检查项（不中止、不回滚任何写动作）。
   */
  doctorCancel: 'workspaceBackup:doctorCancel',
  /**
   * 取消恢复（I6 批次 4 · T01）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**（同上，独立 `ipcMain`）。
   * 语义：**纯信号**——只设「请求在下一个安全点中止」标志，不写盘；一旦进入
   * `publishing` / `registering` 阶段即拒绝（避免半成品/未注册目录）。
   */
  restoreCancel: 'workspaceBackup:restoreCancel',
  /**
   * 读取最近维护审计（I6 批次 4 · T01）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**（同上，独立 `ipcMain`）。
   * 语义：**纯只读**——读 JSONL 最近 N 条，返回**已脱敏**条目；**不**暴露 JSONL 文件路径本身。
   */
  auditRecent: 'workspaceBackup:auditRecent',
  /**
   * 保留策略预览（I6 批次 5 · T01；**只读**，invoke）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**：本通道由
   * `maintenanceMain` 在维护模式下用**独立** `ipcMain` 注册，从不经过 `installWorkspaceIpcGate`
   * （控制不可嵌套）。语义：**纯只读 dry-run**——不取锁、不建目录、不写文件。
   * 返回的视图**只含文件名 / 大小 / 时间 / 保留或清理标记**，**绝不含绝对路径**（对齐 §2.1）。
   */
  retentionPreview: 'workspaceBackup:retentionPreview',
  /**
   * 保留策略确认清理（I6 批次 5 · T01；**写路径**，invoke，带 `confirmToken`）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**（同上，独立 `ipcMain`）。
   * 语义：入参**只有一个** `{ confirmToken }`——**绝不收文件列表**。主进程据 token **自己重算**
   * 候选集（渲染层不得指定删除目标，对齐批次 3 §4.2 S7）。执行是**显式、单次、可审计**的，
   * **无后台自动清理**（D-032 铁律）。
   */
  retentionApply: 'workspaceBackup:retentionApply',
  /**
   * 逐空间完整备份（I6 批次 3.5 · T01；**写路径**，invoke）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**：本通道由
   * `maintenanceMain` 在维护模式下用**独立** `ipcMain` 注册，从不经过 `installWorkspaceIpcGate`
   * （控制不可嵌套）。语义：对指定空间做一次完整备份——**只读开库做一致快照** → 流式打包 →
   * 原子发布到 `backups/`。入参**只有一个 `spaceId`**：空间根由主进程**自己**从注册表解析，
   * 渲染层**不得**传路径（对齐批次 3 §4.2 S7）。
   */
  backupSpace: 'workspaceBackup:backupSpace',
  /**
   * 备份进度（I6 批次 3.5 · T01；主进程 `webContents.send` → 渲染层 `ipcRenderer.on`）。
   *
   * ⚠️ 与 `ipcGate.ts` 的 `control` / `workspaceChanges` 集合**互斥**（同上，独立 `ipcMain` 注册，
   * 从不经过 `installWorkspaceIpcGate`）。语义：**纯可观测性**——最佳努力，丢一两条不影响备份
   * 结果；`detail` 不含本机绝对路径。
   */
  backupProgress: 'workspaceBackup:backupProgress',
  recoveryList: 'workspaceBackup:recoveryList',
  recoveryAction: 'workspaceBackup:recoveryAction'
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
      /** 写锁未取得时仅提供只读维护视图，所有写入口仍拒绝。 */
      writable?: boolean
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
  taskStatus?(request: MaintenanceTaskReference): Promise<MaintenanceTaskStatus>
  cancelTask?(request: MaintenanceTaskReference): Promise<MaintenanceCancelResult>
  overview(): Promise<MaintenanceOverview>
  recoveryList?(cursor?: string): Promise<MaintenanceRecoveryList>
  recoveryAction?(request: MaintenanceRecoveryRequest): Promise<MaintenanceRecoveryResult>
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
  /**
   * 运行**只读**自检（I6 批次 4 · T01，可选）。
   *
   * 全部只读；`request` 为最保守形态（空对象，见 `MaintenanceDoctorRequest` 注释）。
   * 旧主进程不提供时渲染层须先判存在再调用（对齐 `restore` 的可选纪律）。
   */
  doctor?(request?: MaintenanceDoctorRequest): Promise<MaintenanceDoctorResult>
  /**
   * 订阅自检进度（可选增强；返回取消订阅函数）。
   *
   * `progress.detail` **不含本机绝对路径**。旧版本不提供时渲染层应优雅降级（不显示进度）。
   */
  onDoctorProgress?(listener: (progress: MaintenanceDoctorProgress) => void): () => void
  /** 取消自检（可选）：只读取消，停止继续跑剩余检查项。 */
  cancelDoctor?(): Promise<MaintenanceCancelResult>
  /** 取消恢复（可选）：信号语义，只在 `publish` 之前被接受；不可取消阶段返回 `ok:false`。 */
  cancelRestore?(): Promise<MaintenanceCancelResult>
  /**
   * 读取最近维护审计（可选，只读）。
   *
   * 返回**已脱敏**条目数组；**不**暴露 JSONL 文件路径。`limit` 由主进程钳制到安全上限。
   */
  auditRecent?(limit?: number): Promise<MaintenanceAuditView>
  /**
   * 预览保留情况（可选，**只读 dry-run**，I6 批次 5 · T01）。
   *
   * ⚠️ 返回的 `MaintenanceRetentionPreview.items` **绝不含绝对路径**（只有文件名 basename）。
   * 底层先 `listManagedArchives` + `planRetention`（**主进程自己算**），再裁剪成脱敏视图。
   * 旧主进程不提供时渲染层须先判存在再调用（对齐 `auditRecent` 的可选纪律）。
   */
  retentionPreview?(): Promise<MaintenanceRetentionPreview>
  /**
   * 确认清理保留候选（可选，**写路径**，I6 批次 5 · T01）。
   *
   * ⚠️ 入参**只有一个** `token`（来自上一次 `retentionPreview`）——**绝不收文件列表**：
   * 渲染层不得指定删除目标，主进程必须**自己重算**候选并校验 token 与候选集摘要匹配。
   * 旧主进程不提供时渲染层须先判存在再调用。
   */
  applyRetention?(token: string): Promise<MaintenanceRetentionResult>
  /**
   * 对指定空间执行一次完整备份（可选，**写路径**，I6 批次 3.5 · T01）。
   *
   * ⚠️ 入参**只有一个 `spaceId`**——**绝不收路径**：空间根由主进程**自己**从注册表解析，
   * 渲染层不得指定备份源目录（对齐批次 3 §4.2 S7）。可选（`?`）以保持向后兼容：旧渲染层不
   * 认识它，新渲染层须先判存在再调用。
   */
  backupSpace?(request: MaintenanceBackupRequest): Promise<MaintenanceBackupResult>
  /**
   * 订阅备份进度（可选增强；返回取消订阅函数，I6 批次 3.5 · T01）。
   *
   * `progress.detail` **不含本机绝对路径**。可选（`?`）以保持向后兼容：旧渲染层不认识它，
   * 新渲染层须先判存在再调用；旧版本不提供时应优雅降级（不显示进度）。
   */
  onBackupProgress?(listener: (progress: MaintenanceBackupProgress) => void): () => void
}

/** 恢复进度上报（主进程 → 渲染层；**只含阶段与文案，不含任何本机路径**）。 */
export interface MaintenanceRestoreProgress {
  readonly taskId?: string
  readonly cancellable?: boolean
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

export type MaintenanceRecoveryAction = 'register' | 'cleanup'
export type MaintenanceRecoveryStatus = 'pending-registration' | 'registered' | 'staging-retained' | 'interrupted' | 'no-output' | 'cleaned' | 'blocked'
export interface MaintenanceRecoveryItem {
  readonly operationId: string
  readonly spaceName: string
  readonly createdAt: string
  readonly phase: string
  readonly status: MaintenanceRecoveryStatus
  readonly entries: number
  readonly totalBytes: number
  readonly actions: readonly MaintenanceRecoveryAction[]
}
export interface MaintenanceRecoveryList {
  readonly ok: true
  readonly writable: boolean
  readonly items: readonly MaintenanceRecoveryItem[]
  readonly invalidRecords: number
  readonly truncated: boolean
  /** 主进程产生的分页游标，只是操作ID，不接受路径。 */
  readonly nextCursor?: string
}
export interface MaintenanceRecoveryRequest {
  readonly operationId: string
  readonly action: MaintenanceRecoveryAction
}
export type MaintenanceRecoveryResult =
  | { readonly ok: true; readonly operationId: string; readonly action: MaintenanceRecoveryAction; readonly spaceId?: string; readonly alreadyRegistered?: boolean }
  | { readonly ok: false; readonly code: string; readonly detail: string }

/**
 * 恢复结果（主进程 → 渲染层）：**可被沙箱渲染层安全消费**。
 *
 * ⚠️ **绝不**把服务层的 `RestoreOutcome` 原样暴露：它含 `cleanup`（暂存根 / 已发布目标
 * 的本机绝对路径）与 `remap`（T03 全量审计报告），两者都是**本机路径细节**，
 * 泄漏给渲染层既无必要、也扩大暴露面。这里只映射用户可见的必要字段。
 */
export interface MaintenanceRestoreAssociations {
  readonly snapshotsRelinked: number
  readonly unknownSnapshotBuckets: number
  readonly templatesRelinked: number
  readonly unresolvedTemplates: number
  /** 新增可选计数，兼容较早的四字段结果。 */
  readonly externalSnapshotBuckets?: number
}

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
      /** 可选关联计数，旧主进程缺省；不含旧路径或模板内容。 */
      associations?: MaintenanceRestoreAssociations
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

/* ------------------------------------------------------------------------- *
 * I6 批次 4 · T01：自检（doctor）与脱敏审计的共享契约（**全部新增、全部可选**）。
 *
 * 兼容纪律：本段所有类型都是**新增**的；`WorkspaceBackupMaintenanceApi` 上的新增方法
 * 全部为**可选**（`?`），旧渲染层忽略即可、旧主进程不提供时新渲染层需判存在再调用。
 * ------------------------------------------------------------------------- */

/**
 * 单条检查的结论严重度（四级）。
 *
 * ⚠️ `severity` 只描述「技术一致性」的偏离程度，**不含任何科研语义**（对齐 D-038：
 * 拒绝替用户做科研判断，不给「健康度」/「评分」/「是否该清理」的结论）。
 */
export type DoctorSeverity =
  | 'ok' // 通过
  | 'notice' // 可注意（如：发现残留暂存根，可清理但非错误）
  | 'warning' // 偏离（如：某空间 assets.db 缺表 / 外键违规）
  | 'error' // 阻塞性（如：注册表不可读 → 无法继续）

/**
 * 单条自检结论。
 *
 * 形状在**共享契约**中定义（渲染层要消费它），`electron/workspaceBackup/doctorReport.ts`
 * 从此处 import 并 re-export，**只此一处定义**。
 */
export interface DoctorCheck {
  /** 稳定检查 id（SCREAMING_SNAKE，供 UI 与人话映射，不随文案变）。 */
  readonly id: string
  /** 中文短标题。 */
  readonly title: string
  /** 结论严重度（四级）。 */
  readonly severity: DoctorSeverity
  /**
   * 面向用户的说明（中文）。
   *
   * ⚠️ **不含本机绝对路径 / 凭据**：路径只以 basename 或根别名（`<space-root>` / `<home>`）
   * 呈现。这是批次 3 一次真实泄漏（`restoreMain.ts:305` 把 `oldRoot` 绝对路径塞进 detail）
   * 留下的教训，本批所有 detail/文案类字段一律重申此纪律。
   */
  readonly detail: string
  /** 结构化事实计数（可空）。 */
  readonly facts?: Readonly<Record<string, number>>
}

/**
 * 自检报告（四级严重度 + 逐项结论，**绝不汇总成「健康分」**）。
 *
 * `DoctorReport` 的 `checks[].detail` 与整体均已脱敏，可被沙箱渲染层安全消费。
 */
export interface DoctorReport {
  /** 报告生成时刻（ISO）。 */
  readonly at: string
  /** 逐项检查结论（顺序稳定）。 */
  readonly checks: DoctorCheck[]
  /** 汇总计数（便于 UI 概览；**不是**评分）。 */
  readonly summary: { ok: number; notice: number; warning: number; error: number }
}

/**
 * 自检请求（渲染层 → 主进程）。
 *
 * ⚠️ §4.2 纪律：**不接受**渲染层拼的任意路径。为最保守起见，本批 doctor 请求为**空对象**
 * （`Record<string, never>`）——自检所需的 home/归档目录等服务层内部概念一律由主进程从自身
 * 运行环境推导，渲染层无法也不得影响。若将来需限制扫描规模，只允许追加 `limit` 类无害数值
 * 参数，**绝不**允许 `archiveDir` 等路径字段。
 */
export type MaintenanceDoctorRequest = Record<string, never>

/**
 * 自检进度上报（主进程 → 渲染层；对齐 `MaintenanceRestoreProgress` 的形态）。
 *
 * `detail` **不含任何本机绝对路径**（只报「正在检查 X（第 i/n 项）」这类文案，不给百分比，
 * 避免暗示「接近完成」的假象——设计 §8 U4）。
 */
export interface MaintenanceDoctorProgress {
  readonly taskId?: string
  readonly cancellable?: boolean
  /** 阶段标识（如 `scanning-registry` / `verifying-archive` / `checking-space` / `residual`）。 */
  readonly stage: string
  /** 面向用户的阶段说明（中文，**不含本机绝对路径 / 凭据**）。 */
  readonly detail: string
}

/**
 * 自检结果（主进程 → 渲染层）：**单向裁剪**，可被沙箱渲染层安全消费。
 *
 * - 成功：只出 `{ ok:true, at, checks[], summary }`（`checks[].detail` **已脱敏**）。
 * - 失败：只出 `{ ok:false, code, detail }`（**不含**任何本机路径 / 凭据）。
 */
export type MaintenanceDoctorResult =
  | {
      readonly ok: true
      /** 报告生成时刻（ISO）。 */
      readonly at: string
      /** 逐项检查结论（已脱敏）。 */
      readonly checks: DoctorCheck[]
      /** 汇总计数（**不是**评分）。 */
      readonly summary: { ok: number; notice: number; warning: number; error: number }
    }
  | {
      readonly ok: false
      /** 失败码（SCREAMING_SNAKE；渲染层据此给出人话文案）。 */
      readonly code: string
      /** 面向用户的说明（**不含**本机绝对路径 / 凭据）。 */
      readonly detail: string
    }

/**
 * 取消类请求的返回（`cancelDoctor` / `cancelRestore` 共用）。
 *
 * 语义：**信号**——`ok:true` 表示取消请求已被接受（自检：停止继续跑；恢复：在下一个安全点
 * 中止），**不**代表动作已立即停止，也**不**代表任何写动作被回滚。
 */
export interface MaintenanceCancelResult {
  /** 取消请求是否被接受。 */
  readonly ok: boolean
  /** 未接受时的原因码（SCREAMING_SNAKE；如不可取消阶段）。 */
  readonly code?: string
}

/**
 * 允许落审计的条目形状（**白名单字段，无自由挂载位**）。
 *
 * 审计 writer 只接受本形状，**不接受任意对象**——从类型上就杜绝「顺手塞进整条记录」。
 * 所有值均已脱敏：`labels` 的值只允许空间**名** / 归档**文件名（basename）**，**绝不含绝对路径**。
 */
export interface MaintenanceAuditEntry {
  /** 记录时刻（ISO）。 */
  readonly at: string
  /**
   * 动作类别。
   *
   * - `restore`   —— 恢复为新空间（批次 3）；
   * - `doctor`    —— 只读自检（批次 4）；
   * - `retention` —— 保留策略的**显式**清理（批次 5）；
   * - `backup` —— 逐空间完整备份（批次 3.5）。
   *
   * ⚠️ 新增动作必须**同时**更新本联合类型与 `auditWriter` 的调用方：
   * 类型是「可落审计的动作」的**唯一白名单**，绝不能为图省事用 `as unknown as` 绕过
   * （那会让「哪些动作会落审计」在类型上不可见，维护者无从审计）。
   */
  readonly action: 'restore' | 'doctor' | 'retention' | 'backup'
  /** 结果。 */
  readonly outcome: 'ok' | 'failed'
  /** 失败码（SCREAMING_SNAKE，非自由文本）。 */
  readonly code?: string
  /** 计数类事实（条目数 / 字节 / 改写数 / 检查项数…）。 */
  readonly counts?: Readonly<Record<string, number>>
  /** 脱敏后的**标识**：空间**名**、归档**文件名（basename）**；**绝不含绝对路径 / 凭据**。 */
  readonly labels?: Readonly<Record<string, string>>
}

/**
 * 审计查看结果（主进程 → 渲染层）。
 *
 * 只出**已脱敏**条目数组；**不**暴露 JSONL 文件路径本身（对齐 §4.3 裁剪纪律）。
 */
export interface MaintenanceAuditView {
  /** 最近 N 条审计条目（已脱敏；按时间倒序或读者既定顺序）。 */
  readonly entries: MaintenanceAuditEntry[]
  /** 读取时跳过的坏行数（半行截断容错计数；无则为 0）。 */
  readonly skipped: number
}

/* ------------------------------------------------------------------------- *
 * I6 批次 5 · T01：保留策略的共享契约（**全部新增、全部可选**）。
 *
 * 兼容纪律（沿用批次 3/4）：本段所有类型都是**新增**的；`WorkspaceBackupMaintenanceApi`
 * 上的新增方法（`retentionPreview` / `applyRetention`）全部为**可选**（`?`），旧渲染层忽略
 * 即可、旧主进程不提供时新渲染层需判存在再调用。
 * ------------------------------------------------------------------------- */

/**
 * 预览中的单条归档（**已脱敏**，可被沙箱渲染层安全消费）。
 *
 * ⚠️ `name` 是**文件名 basename**，**非绝对路径**：路径只由主进程内部持有（对齐 §2.1 与
 * 批次 4 §4.3 裁剪纪律）。
 */
export interface MaintenanceRetentionItem {
  /** 文件名（basename，**非绝对路径**）。 */
  readonly name: string
  /** 字节数。 */
  readonly bytes: number
  /** 最后修改时刻（ISO）。 */
  readonly modifiedAt: string
  /** 处置：保留 or 清理。 */
  readonly disposition: 'keep' | 'remove'
  /** 原因（`recent` | `within-days` | `beyond-keep`）。 */
  readonly reason: string
}

/**
 * 保留预览结果（主进程 → 渲染层）。
 *
 * 成功含 `confirmToken`（一次性，绑定「本次预览的候选集摘要」）与 `keepPolicy`（策略份数）。
 * 失败只出 `{ ok:false, code, detail }`（**不含**本机路径）。
 */
export type MaintenanceRetentionPreview =
  | {
      readonly ok: true
      /** 逐条归档（已脱敏；**不含绝对路径**）。 */
      readonly items: MaintenanceRetentionItem[]
      /** 可释放字节合计。 */
      readonly reclaimableBytes: number
      /** 一次性确认 token（由主进程生成，绑定本次候选集摘要）。 */
      readonly confirmToken: string
      /** 当前保留策略份数（本批固定 20）。 */
      readonly keepPolicy: number
    }
  | {
      readonly ok: false
      /** 失败码（SCREAMING_SNAKE）。 */
      readonly code: string
      /** 面向用户的说明（**不含**本机绝对路径 / 凭据）。 */
      readonly detail: string
    }

/**
 * 确认清理结果（主进程 → 渲染层）。
 *
 * ⚠️ **不承诺全成功**：`failed` 如实上报（每条结果如实，不掩盖，对齐 §2.2 失败语义）。
 */
export type MaintenanceRetentionResult =
  | {
      readonly ok: true
      /** 已删除份数。 */
      readonly removed: number
      /** 删除失败份数（如实上报，不掩盖）。 */
      readonly failed: number
      /** 实际释放字节。 */
      readonly reclaimedBytes: number
    }
  | {
      readonly ok: false
      /** 失败码（SCREAMING_SNAKE；如 `TOKEN_MISMATCH`）。 */
      readonly code: string
      /** 面向用户的说明（**不含**本机绝对路径 / 凭据）。 */
      readonly detail: string
    }

/* ------------------------------------------------------------------------- *
 * I6 批次 3.5 · T01：逐空间完整备份的共享契约（**全部新增、全部可选**）。
 *
 * 兼容纪律（沿用批次 3/4/5）：本段所有类型都是**新增**的；`WorkspaceBackupMaintenanceApi`
 * 上的新增方法（`backupSpace` / `onBackupProgress`）全部为**可选**（`?`），旧渲染层忽略
 * 即可、旧主进程不提供时新渲染层需判存在再调用。
 * ------------------------------------------------------------------------- */

/** 备份请求（渲染层 → 主进程）。**只传 spaceId，绝不由渲染层传路径**（对齐批次 3 §4.2 S7）。 */
export interface MaintenanceBackupRequest {
  readonly spaceId: string
}

/**
 * 备份结果（主进程 → 渲染层）。
 *
 * ⚠️ `archiveName` 是**文件名 basename**，**非绝对路径**：路径只由主进程内部持有。
 */
export type MaintenanceBackupResult =
  | {
      readonly ok: true
      readonly spaceId: string
      /** 空间**名**（非路径）。 */
      readonly name: string
      /** 归档文件名（basename，非绝对路径）。 */
      readonly archiveName: string
      /** 纳入清单的条目数。 */
      readonly entries: number
      /** 清单展开总字节。 */
      readonly totalBytes: number
      /** 归档文件字节。 */
      readonly archiveBytes: number
      /** 未纳入项数（超限单文件；**不静默丢弃**，如实上报）。 */
      readonly excluded: number
      /** 是否含资产库快照（空间无 `assets.db` 时为 false）。 */
      readonly hasAssetsDb: boolean
    }
  | {
      readonly ok: false
      /** 失败码（SCREAMING_SNAKE）。 */
      readonly code: string
      /** 面向用户的说明（**不含**本机绝对路径 / 凭据）。 */
      readonly detail: string
    }

/** 备份进度上报（主进程 → 渲染层；**只含阶段与文案，不含任何本机路径**）。 */
export interface MaintenanceBackupProgress {
  readonly taskId?: string
  readonly cancellable?: boolean
  readonly stage: string
  readonly detail: string
}

export type MaintenanceTaskKind = 'backup' | 'restore' | 'doctor'
export type MaintenanceTaskState = 'running' | 'cancelling' | 'committing' | 'done' | 'failed' | 'cancelled'
export interface MaintenanceTaskReference { readonly taskId: string }
export interface MaintenanceTaskView extends MaintenanceTaskReference {
  readonly kind: MaintenanceTaskKind
  readonly state: MaintenanceTaskState
  readonly stage: string
  readonly cancellable: boolean
}
export interface MaintenanceTaskProgress extends MaintenanceTaskView { readonly detail: string }
export type MaintenanceTaskStatus = { readonly ok: true; readonly task: MaintenanceTaskView } | { readonly ok: false; readonly code: string }
