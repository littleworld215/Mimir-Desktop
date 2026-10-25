/**
 * 维护模式自检 / 审计 / 取消 IPC 装配（I6 批次 4 · T04）。
 *
 * 职责：把服务层的**只读自检**（`buildDoctorReport`）、**脱敏审计**（`appendMaintenanceAudit` /
 * `readRecentMaintenanceAudit`）接到维护窗口的 IPC 通道上，并**只向渲染层暴露必要字段**。
 * 本文件刻意把「纯逻辑」与「Electron 接线」分开（照 `maintenanceRestoreHandler.ts` 的范式）：
 *
 * - `toDoctorResult`：**纯函数**，零 IO、零 Electron 依赖，直接单测。它是 `DoctorReport`
 *   到 `MaintenanceDoctorResult` 的**单向裁剪**——只出用户可见字段，**绝不**带出本机路径。
 * - `buildDoctorHandler`：把纯函数 + 服务层装配成一个 `{ doctor, auditRecent }` 处理器，
 *   **不 import electron**（`buildReport` / `readAudit` / `writeAudit` 经 deps 注入），
 *   因此可在不启动 Electron 的情况下端到端单测。
 * - `registerDoctorHandler`：唯一接触 `ipcMain` 的地方，由 `maintenanceMain` 调用。
 *
 * 纪律（逐条落实任务书 / 设计稿 §4.3）：
 * 1. **不 import electron**：所有 Electron 相关能力（sender 校验 / 通道注册）经形参注入。
 * 2. **只读**：doctor 全链路只读（`buildDoctorReport` 内部保证「不取锁、不建目录、不写文件」）；
 *    审计读（`auditRecent`）同样只读、不暴露 JSONL 文件路径。
 * 3. **裁剪纪律**：`toDoctorResult` 成功只出 `{ ok, at, checks[], summary }`（`checks[].detail`
 *    已脱敏）；失败只出 `{ ok, code, detail }`，**任何字段都不含**本机路径 / 暂存根路径 / home。
 * 4. **审计尽力而为**：`doctor()` 执行后写审计是**旁路**——`writeAudit` 内部已 try/catch，
 *    本层**再包一层 try/catch** 以防注入实现抛错，**绝不影响**返回结果（对齐设计稿 S-A3 / K6）。
 * 5. **不硬编码通道**：`registerDoctorHandler` 一律用 `WORKSPACE_BACKUP_CHANNELS.*`
 *    （批次 3 有一次硬编码教训——控制通道必须是单一事实源）。
 */

import {
  WORKSPACE_BACKUP_CHANNELS,
  type DoctorCheck,
  type DoctorReport,
  type MaintenanceAuditEntry,
  type MaintenanceAuditView,
  type MaintenanceDoctorRequest,
  type MaintenanceDoctorResult
} from '../../shared/workspaceBackupContracts'
import { buildDoctorReport, type DoctorDeps, type DoctorProgress } from './doctorReport'
import type { AssetsIntegrityOptions } from './assetsIntegrity'
import { checkMaintenanceCancellation } from './maintenanceTask'
import { appendMaintenanceAudit } from './auditWriter'
import { readRecentMaintenanceAudit } from './auditReader'

/**
 * `buildDoctorHandler` 的依赖（全部注入，便于单测；**不含任何 Electron 类型**）。
 *
 * - `homeDir` 必传（生产 = `homedir()`；测试 = 合成目录）。
 * - `buildReport` / `readAudit` / `writeAudit` 可注入以隔离 IO：缺省即真实只读原语
 *   （`buildDoctorReport` / `readRecentMaintenanceAudit` / `appendMaintenanceAudit`）。
 */
export interface DoctorHandlerDeps {
  /** 注册表 home（生产 = `homedir()`；测试 = 合成目录）。 */
  readonly homeDir: string
  readonly assetsIntegrityOptions?: AssetsIntegrityOptions
  /** 自检进度回调（生产 = `owner.webContents.send`；单测可注入以断言进度被上报）。 */
  readonly onProgress?: (p: DoctorProgress) => void
  /**
   * 执行一次只读自检（缺省 = `buildDoctorReport`）。
   * 注入点存在理由：单测可传入假实现精确断言返回结构，不必真的扫盘。
   */
  readonly buildReport?: (deps: DoctorDeps) => Promise<DoctorReport>
  /** 读取最近审计（缺省 = `readRecentMaintenanceAudit`）；返回**已脱敏**视图。 */
  readonly readAudit?: (home: string, limit?: number) => MaintenanceAuditView
  /** 追加一条审计（缺省 = `appendMaintenanceAudit`）；**尽力而为**，抛错不得影响 doctor。 */
  readonly writeAudit?: (home: string, entry: MaintenanceAuditEntry) => void
  /** 未持维护写锁或会话已失效时，保留自检读取能力但禁止旁路落盘。 */
  readonly auditAllowed?: () => boolean
}

/** 自检处理器集合：`doctor()` 跑一次只读自检并留审计；`auditRecent(limit)` 只读最近审计。 */
export interface DoctorHandler {
  /** 运行一次只读自检，返回**单向裁剪**后的结果（永不抛）。 */
  doctor(): Promise<MaintenanceDoctorResult>
  /** 只读最近 N 条审计（已脱敏，不暴露文件路径）。 */
  auditRecent(limit?: number): Promise<MaintenanceAuditView>
}

/**
 * 把 `DoctorReport` **单向裁剪**成渲染层可安全消费的 `MaintenanceDoctorResult`。
 *
 * ⚠️ 映射是**单向裁剪**（对齐 §4.3）：成功只取 `{ ok, at, checks, summary }`。
 * - **绝不**带出任何本机路径 / 暂存根路径 / home 值：`DoctorReport` 本身已不含这些字段，
 *   但此处仍对每条 `check` 做**字段级白名单重建**（只保留 `id/title/severity/detail/facts`），
 *   以防上游将来给 `DoctorCheck` 加了内部字段而无意泄漏——**白名单**比**黑名单**安全。
 * - `checks[].detail` 在 `buildDoctorReport` 内已过 `redactText`，此处不再二次处理（幂等），
 *   保持「脱敏只在一处实现」。
 *
 * @param report 自检报告（`checks[].detail` 已脱敏）。
 * @returns 渲染层结果：`{ ok:true, at, checks, summary }`。
 */
export function toDoctorResult(report: DoctorReport): Extract<MaintenanceDoctorResult, { ok: true }> {
  const checks: DoctorCheck[] = report.checks.map((check) => {
    // 字段级白名单重建：只保留契约字段，杜绝「顺手带上内部字段」。
    const safe: DoctorCheck = {
      id: check.id,
      title: check.title,
      severity: check.severity,
      detail: check.detail
    }
    // `facts` 为可选；仅在存在时保留（且结构上只是 number 计数，无路径可言）。
    return check.facts === undefined ? safe : { ...safe, facts: check.facts }
  })
  return {
    ok: true,
    at: report.at,
    checks,
    summary: report.summary
  }
}

/**
 * 构造自检处理器（不 import electron，可在 node 下单测）。
 *
 * `doctor()`：**跑只读自检 → 单向裁剪 → 尽力而为留审计 → 返回裁剪结果**。
 * 关键纪律：审计写入是**旁路**——即使 `writeAudit` 抛错，也**必须**返回自检结果
 * （`writeAudit` 内部已 try/catch，本层再包一层纵深防御，防注入实现抛错）。
 *
 * `auditRecent(limit)`：直接转发到 `readAudit(home, limit)`，返回**已脱敏**视图。
 *
 * @param deps 依赖（`homeDir` 必传；其余可注入；缺省走真实只读原语）。
 * @returns `{ doctor, auditRecent }` 处理器。
 */
export function buildDoctorHandler(deps: DoctorHandlerDeps): DoctorHandler {
  const buildReport = deps.buildReport ?? buildDoctorReport
  const readAudit = deps.readAudit ?? readRecentMaintenanceAudit
  const writeAudit = deps.writeAudit ?? appendMaintenanceAudit

  return {
    async doctor(): Promise<MaintenanceDoctorResult> {
      // ① 跑只读自检（`buildDoctorReport` 内部已保证「不取锁、不建目录、不写文件」）。
      const report = await buildReport({
        home: deps.homeDir,
        assetsIntegrityOptions: deps.assetsIntegrityOptions,
        ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {})
      })

      // ② 单向裁剪（防任何内部字段 / 本机路径外泄）。
      checkMaintenanceCancellation()
      const result = toDoctorResult(report)

      // ③ 审计留痕：**尽力而为**。writeAudit 内部已 try/catch；此处再包一层以防御
      //    注入实现（单测会注入一个「必抛」的实现，断言 doctor 仍返回成功）。
      //    审计 entry 是**白名单形状**：只记 at/action/outcome/counts，**绝不含路径**。
      try {
        if (deps.auditAllowed?.() !== false) writeAudit(deps.homeDir, {
          at: report.at,
          action: 'doctor',
          outcome: 'ok',
          counts: {
            checks: result.checks.length,
            ok: result.summary.ok,
            notice: result.summary.notice,
            warning: result.summary.warning,
            error: result.summary.error
          }
        })
      } catch {
        // 审计失败绝不影响自检结果（S-A3 / K6）。
      }

      return result
    },

    async auditRecent(limit?: number): Promise<MaintenanceAuditView> {
      // 只读；`readAudit` 内部已钳制 limit 上限、不建目录、不暴露文件路径。
      return readAudit(deps.homeDir, limit)
    }
  }
}

/** `ipcMain.handle` 的最小形状（避免 import electron，便于单测直接复用签名）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/**
 * 注册自检 / 审计 handler 到维护窗口的 `ipcMain`（**唯一接触 Electron 的地方之一**）。
 *
 * - `doctor` / `auditRecent` 通道用 `WORKSPACE_BACKUP_CHANNELS.*`（与 preload 硬编码字符串一致）；
 *   **绝不硬编码通道名**（批次 3 有一次硬编码教训）。
 * - sender 校验复用维护窗口的 `trusted(event)`：不通过即 `throw Error('UNAUTHORIZED_SENDER')`
 *   —— 与既有 `overview` / `restore` handler 同口径。
 *
 * ⚠️ 纪律「控制不可嵌套」：本通道**不**经 `installWorkspaceIpcGate`；自检是**只读**，
 * 绝不调任何 `workspaces:*` IPC。**不要**把本通道加进 `ipcGate.ts` 的 `control` /
 * `workspaceChanges` 集合。
 *
 * @param ipc 生产 = `ipcMain`（`electron`）；单测可传假实现。
 * @param trusted sender 校验（生产 = `maintenanceMain` 里的 `trusted`）。
 * @param handler 由 `buildDoctorHandler` 构造。
 */
export function registerDoctorHandler(
  ipc: IpcMainLike,
  trusted: (event: unknown) => boolean,
  handler: DoctorHandler
): void {
  ipc.handle(
    WORKSPACE_BACKUP_CHANNELS.doctor,
    (event: unknown, request: unknown): Promise<MaintenanceDoctorResult> => {
      if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
      // 自检请求为最保守形态（空对象）：忽略渲染层传入值，主进程自行推导 home。
      void (request as MaintenanceDoctorRequest | undefined)
      return handler.doctor()
    }
  )

  ipc.handle(
    WORKSPACE_BACKUP_CHANNELS.auditRecent,
    (event: unknown, limit: unknown): Promise<MaintenanceAuditView> => {
      if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
      // 渲染层可能给出非数字：`readAudit` 内部会钳制（非有限数 → 0），此处只做类型收窄。
      const parsed = typeof limit === 'number' ? limit : undefined
      return handler.auditRecent(parsed)
    }
  )
}
