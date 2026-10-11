/**
 * 维护窗口（I6 备份/恢复）与渲染层共享的契约。
 *
 * 兼容纪律：本文件同时被 `electron/workspaceBackup/maintenanceMain.ts`（主进程）
 * 与 `src/renderer/maintenance.tsx`（沙箱渲染层）加载。**新增字段一律可选**，
 * 不改既有字段的形状与含义——渲染层可能是旧版本、主进程可能是新版本，双向都要能解析。
 */

/** 维护窗口 IPC 通道。 */
export const WORKSPACE_BACKUP_CHANNELS = {
  overview: 'workspaceBackup:overview'
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
 * 批次 3 仍**只开放只读浏览**：恢复的写入路径（解压 / 发布 / 注册）由主进程在
 * 维护模式下以自身持有的写者会话执行，不通过本桥暴露任意路径拼接能力（设计 §4.2 S7）。
 */
export interface WorkspaceBackupMaintenanceApi {
  overview(): Promise<MaintenanceOverview>
}
