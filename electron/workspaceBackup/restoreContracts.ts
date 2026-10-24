/**
 * 新空间恢复契约（I6 批次 3 · 第 1 块）。
 *
 * 职责：定义恢复流程的**类型、阶段枚举、失败语义与错误码**，供后续
 * `restoreState`（状态机）、`restorePlan`（计划）、以及 T02+（解压/发布/注册）复用。
 *
 * 纪律（对应 `docs/design/I6-BATCH3-RESTORE.md` §1）：
 * - **本文件零 IO、零依赖**：只放类型、常量与错误类，能被纯单测直接加载。
 * - 错误码命名与批次 2 一致（`TARGET_EXISTS` / `DIGEST_MISMATCH` 那种 SCREAMING_SNAKE）。
 * - 阶段枚举与失败语义**一一对应**设计的 §1.3 表；改动此处必须同步设计文档。
 */

/** 恢复流程阶段（对应设计 §1.1 的 10 态；`failed` 为终态但非破坏态）。 */
export type RestoreStage =
  | 'idle'
  | 'inspecting'
  | 'planned'
  | 'extracting'
  | 'verifying'
  | 'publishing'
  | 'registering'
  | 'done'
  | 'failed'

/** 驱动状态机的事件（对应设计 §1.1）。 */
export type RestoreEvent =
  | 'selectArchive'
  | 'verifyOk'
  | 'verifyFail'
  | 'planReady'
  | 'userConfirm'
  | 'userCancel'
  | 'extractOk'
  | 'extractFail'
  | 'recheckOk'
  | 'recheckFail'
  | 'publishOk'
  | 'publishFail'
  | 'registerOk'
  | 'registerFail'
  | 'retry'
  | 'abort'

/** 恢复错误码（SCREAMING_SNAKE；与批次 2 风格一致）。 */
export type RestoreErrorCode =
  // 计划/落点
  | 'TARGET_EXISTS'
  | 'INVALID_TARGET'
  | 'NOT_LOCAL_DISK'
  // 暂存
  | 'STAGING_CONFLICT'
  | 'STAGING_CLEANUP_FAILED'
  // 解压
  | 'EXTRACT_FAILED'
  | 'PATH_ESCAPE'
  | 'ENTRY_LIMIT'
  | 'UNSAFE_ENTRY'
  // 验包（inspecting 阶段：来自批次 2 的 `verify.ts`，必须如实透出而非降级为 INTERNAL）
  // 设计 §1.3 第 1 行明写「明文错误码 + 中文说明」——故这些码必须在白名单内，
  // 否则 `restoreRunner.asRestoreError` 会把它们归一成无信息量的 `INTERNAL`。
  | 'OPEN_FAILED'
  | 'READ_FAILED'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_LIMIT'
  | 'TOTAL_LIMIT'
  | 'LIMIT_INVALID'
  | 'MISSING_ENTRY'
  | 'EXTRA_ENTRY'
  | 'DUPLICATE_ENTRY'
  | 'SIZE_MISMATCH'
  | 'VERSION_UNSUPPORTED'
  // 复校
  | 'RECHECK_FAILED'
  | 'DIGEST_MISMATCH'
  | 'INTEGRITY_FAILED'
  // 发布
  | 'PUBLISH_FAILED'
  // 注册
  | 'REGISTER_FAILED'
  | 'REGISTRY_INVALID'
  | 'LOCK_UNAVAILABLE'
  // 控制
  | 'CONTROL_TIMEOUT'
  | 'CONTROL_BLOCKED'
  // 通用
  | 'INTERNAL'

/** 一份恢复失败的完整描述（对应设计 §1.3 每一行的「失败点」）。 */
export interface RestoreFailure {
  /** 失败发生在哪个阶段。 */
  readonly stage: RestoreStage
  readonly code: RestoreErrorCode
  /** 是否可通过 `retry` 事件重试（见 §1.3；`inspecting` 失败需换归档，非本操作内重试）。 */
  readonly retryable: boolean
  /** 面向用户的补充说明（不含凭据/正文）。 */
  readonly detail: string
}

/** 带错误码的恢复异常（与批次 2 的 `VerifyError`/`BackupError` 同构）。 */
export class RestoreError extends Error {
  readonly code: RestoreErrorCode
  constructor(code: RestoreErrorCode, message: string) {
    super(message)
    this.name = 'RestoreError'
    this.code = code
  }
}

/** 恢复计划：验包通过后、落盘前产出的只读方案（供用户确认）。 */
export interface RestorePlan {
  /** 归档文件路径（绝对）。 */
  readonly archivePath: string
  /** 目标新空间根（绝对、必须不存在）。 */
  readonly targetRoot: string
  /** 同盘暂存根（绝对、位于 targetRoot 的父目录下）。 */
  readonly stagingRoot: string
  /** 归档内条目数（来自验包结果）。 */
  readonly entries: number
  /** 归档内文件展开总字节（来自验包结果）。 */
  readonly totalBytes: number
  /** 归档格式版本（来自验包结果）。 */
  readonly formatVersion: number
}

/** 恢复结果：`done` 时给出新空间登记信息。 */
export interface RestoreResult {
  /** 新空间 id（新 UUID）。 */
  readonly spaceId: string
  readonly name: string
  /** 新空间根（绝对）。 */
  readonly root: string
  readonly entries: number
  readonly totalBytes: number
}

/**
 * 清理范围：`failed` 终态的 `abort` 只允许清理「本操作产物」。
 *
 * **安全约束（设计 §1.3 规则 2）**：`stagingRoot` 与 `createdTarget` 之外的任何路径
 * ——尤其是**原空间根**、**原注册表文件**、**其它空间目录**——**绝不允许**出现在这里。
 * `restoreState.abortScope` 的返回值必须满足该约束（由测试断言证明）。
 */
export interface CleanupScope {
  /** 本次操作的暂存根（可清理）。 */
  readonly stagingRoot: string
  /** 本次操作已发布但未注册成功的新目录；仅在确由本操作创建时才非 null。 */
  readonly createdTarget: string | null
}

/** 暂存根目录名前缀（设计 §2.1：与目标同盘、以点开头、不进入任何清单）。 */
export const RESTORE_STAGING_PREFIX = '.mimir-restore-staging-'
