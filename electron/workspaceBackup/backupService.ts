/**
 * 逐空间完整备份的**编排服务层**（I6 批次 3.5 · T03）。
 *
 * 职责：把批次 2 的打包原语 `createBackup`、批次 5 的归档命名规范 `deriveArchiveName`、
 * 批次 4 的只读注册表解析 `readRegistrySpacePaths` 与脱敏审计 `appendMaintenanceAudit`
 * 组装成**一次可被主进程直接调用的备份动作** `runSpaceBackup`。
 *
 * ── 为什么需要本层（缺口来源） ────────────────────────────────────────────
 * 批次 2 落地了 `createBackup` 打包原语，但**生产代码里没有任何调用点**——归档既不会被产出、
 * 也不会落进 `backups/`，导致批次 5 的保留策略在真实运行中找不到归档、批次 6 的闭环验证无对象可验。
 * 本层就是那条缺失的接线：**唯一**知道「如何把一次备份请求编排出来」的地方。
 *
 * ── 四条铁律（对齐设计 §1.1 / §5 风险表） ────────────────────────────────
 * 1. **只传 id，绝不信路径**（K4 / §4.2 S7）：入参只有 `spaceId`；空间根由本层**自己**从
 *    只读注册表解析。渲染层无法指定备份源目录。
 * 2. **未动盘就零副作用**（对齐 `retentionService`）：步骤 ①（校验入参）/ ②（解析注册表）/
 *    ③（取锁）任一失败时，**不建目录、不写审计**——「没动盘就不该留执行记录」。仅当**确已动盘**
 *    （打开库 / 建 `backups/` / 打包）之后发生的失败才写 `outcome:'failed'` 审计。
 * 3. **绝不静默降级**（K6）：库**不存在**才允许走「无库归档」；库**存在但打开失败**一律报
 *    `BACKUP_FAILED`——绝不把「打开失败」伪装成「本来就没库」。
 * 4. **出口单向裁剪**（K4）：返回值的**任何字段**都不含本机绝对路径；归档一律只给 `basename`。
 *    审计 `labels` 只放空间**名**与归档 `basename`。
 *
 * ── 只读的精确措辞（K3 / 设计 §0.2(a)） ──────────────────────────────────
 * 本层以 `readonly:true` 打开源库做一致快照，**不修改源库内容**。但 SQLite 只读打开 **WAL 模式**
 * 库仍会在源目录创建 `-shm` / `-wal`（共享内存索引），故「只读」**不等于**「不触碰源目录」。
 * 这些瞬态文件不进归档（由批次 3.5 T02 的 `manifest.ts` 后缀排除保证）。
 *
 * ── IO 全可注入（不 import electron，便于单测隔离） ──────────────────────
 * `BackupSpaceDeps` 的 `resolveSpaces` / `openAssetsDb` / `createBackup` / `acquireSpaceLock` /
 * `writeAudit` 全部可注入。生产缺省走真实 `fs` / `better-sqlite3` / `operationGate` / `auditWriter`；
 * 单测注入假实现即可在 `mkdtemp` 合成 home 上跑，无需真实 Electron、无需真实原生绑定。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'

import type {
  MaintenanceAuditEntry,
  MaintenanceBackupProgress,
  MaintenanceBackupRequest,
  MaintenanceBackupResult
} from '../../shared/workspaceBackupContracts'
// 只读注册表解析（含空间根 path）——逐字复用批次 4 的实现，**绝不** loadStore（那会写盘）。
import { readRegistrySpacePaths, type SpacePathView } from './doctorSpaceScan'
// 打包原语（批次 2）。
import { createBackup } from './packer'
// 归档命名规范（批次 5）。
import { deriveArchiveName } from './archiveNaming'
// 归档目录单一事实源（批次 3.5 · T01）。
import { archiveDirectory } from './directories'
// 写者锁原语（批次 1/3）：只取锁，**绝不按 PID / 年龄猜残锁**（对齐 S6）。
import { acquireWriterLockFile } from './operationGate'
// 脱敏审计（批次 4）。
import { appendMaintenanceAudit } from './auditWriter'
// 原生绑定解析（与 assetsIntegrity 同一套）：让单测可传 nativeBinding 跳过 Electron 依赖。
import { resolveAssetsNativeBinding } from '../assets/nativeBinding'

/**
 * 源库相对空间根的正斜杠路径（与清单 / 打包注入点一致）。
 *
 * 打包时 `createBackup` 用它定位「用快照内容替换实时文件」的注入点（`packer.ts:183`），
 * 故这是**打包与清单共享的一个约定**，不能各写一遍。
 */
export const ASSETS_DB_REL_PATH = '.mimir/assets/assets.db'

/** 空间写锁文件名（与 `operationGate.acquireWorkspaceLock` 的默认名一致）。 */
const WRITER_LOCK_NAME = 'workspace.writer-lock'

/**
 * 暂存目录名（`backups/` 下的隐藏子目录）。
 *
 * **为什么放在 `backups/` 内**（§1.3）：
 * - **必须与 destination 同盘**：`createBackup` 用 `renameSync(stagingArchive, destination)` 原子发布
 *   （`packer.ts:208`）；跨卷 rename 会失败（`EXDEV`）。destination ∈ `backups/`，故暂存也放 `backups/` 下。
 * - **以 `.` 开头**：`listManagedArchives`（保留策略白名单）只认 `mimir-backup-*.zip`（`archiveNaming`
 *   的正则首尾锚点），`.staging` 天然不被匹配，绝不会被误当归档清理。
 */
const STAGING_DIR_NAME = '.staging'

/**
 * 打开源库做快照的最小句柄形状。
 *
 * 刻意**不**直接用 `Database.Database` 全类型：本层只用到 `backup()` 与 `close()`，
 * 收窄为结构化接口后单测可传最简假对象，无需任何原生绑定（对齐 `retentionService` 的注入范式）。
 */
export interface AssetsDbHandle {
  /** 把库的一致快照写到 `dest`（SQLite `VACUUM INTO` 语义，原子且已 checkpoint）。 */
  backup(dest: string): Promise<void>
  /** 关闭句柄（无论成败都必须调用，绝不泄漏）。 */
  close(): void
}

/** 空间写锁句柄（只需能释放）。 */
export interface SpaceLockHandle {
  /** 释放写锁（幂等；实现见 `operationGate.acquireWriterLockFile` 返回的 `release`）。 */
  release(): void
}

/**
 * 服务层依赖（除 `home` 外全部可选，缺省即生产行为）。
 */
export interface BackupSpaceDeps {
  /** 用户 home 目录（本机数据根；归档落 `<home>/backups`，审计落 `<home>/.mimir/logs`）。 */
  readonly home: string
  /** 注入时钟（测试用）；缺省 `() => new Date()`。 */
  readonly now?: () => Date
  /** 只读解析已登记空间；缺省 `readRegistrySpacePaths`（来自 `./doctorSpaceScan`）。 */
  readonly resolveSpaces?: (home: string) => SpacePathView[]
  /**
   * 打开源库做快照；缺省用 `better-sqlite3` 只读打开。
   *
   * 注入以隔离 IO / 单测：生产缺省实现在本文件内定义（`openAssetsDbReadonly`），
   * 单测可传假 `{ backup, close }` 完全跳过原生绑定。
   */
  readonly openAssetsDb?: (dbPath: string) => AssetsDbHandle
  /** 打包原语；缺省 `createBackup`（`./packer`）。 */
  readonly createBackup?: typeof createBackup
  /**
   * 取目标空间写锁；缺省实现见本文件 `defaultAcquireSpaceLock`（包装 `acquireWriterLockFile`）。
   *
   * ⚠️ 作为**可用性检查**而非「并发防护」（§1.2）：维护模式下普通窗口已关闭，理论上无并发写者；
   * 但「取锁成功」把「是否有并发写者」变成**可验证的事实**，而非依赖「维护模式应该没写者」的**假设**。
   * 锁被占用即拒绝（`LOCK_UNAVAILABLE`），**绝不**按 PID / 年龄猜残锁（对齐 `operationGate` 纪律）。
   */
  readonly acquireSpaceLock?: (spaceRoot: string) => SpaceLockHandle
  /** 审计写入；缺省 `appendMaintenanceAudit`（`./auditWriter`）。 */
  readonly writeAudit?: (home: string, entry: MaintenanceAuditEntry) => void
  /** 进度回调（可选增强）。 */
  readonly onProgress?: (progress: MaintenanceBackupProgress) => void
  /**
   * 原生绑定解析选项（透传给 `resolveAssetsNativeBinding`）。
   *
   * 现实意义：让主进程在**打包运行**时能给出 `app.asar.unpacked` 下的绑定路径、让单测能直接
   * 传一个已解析的 `nativeBinding` 跳过 Electron 依赖。**没有**这些参数，缺省只读打开在
   * 打包环境会因找不到绑定而失败。
   */
  readonly isPackaged?: boolean
  /** Electron `process.resourcesPath`（打包后必需）。 */
  readonly resourcesPath?: string
  /** 开发模式应用根（定位 `.native/` 缓存）；缺省 `process.cwd()`。 */
  readonly appRoot?: string
  /** 已解析的 `nativeBinding`（单测用；给了即跳过解析）。 */
  readonly nativeBinding?: string
}

/**
 * 缺省只读打开源库。
 *
 * - **`readonly:true`**：只做一致快照，**绝不**修改源库内容（K3 措辞精确化：不代表不触碰源目录）。
 * - 原生绑定解析**照抄 `assetsIntegrity.resolveBinding`**：`nativeBinding` → 直接返回；
 *   否则 `resolveAssetsNativeBinding({ isPackaged, resourcesPath, appRoot })`。这样单测传
 *   `nativeBinding`（或什么都不传，走 Node ABI 默认解析）即可脱离 Electron。
 *
 * ⚠️ 打开失败（含绑定不可用）**不在本函数内吞**——由调用方 `runSpaceBackup` 收敛为
 * `BACKUP_FAILED`（K6：绝不静默降级为「无库归档」）。
 */
export function openAssetsDbReadonly(
  dbPath: string,
  bindingOptions: Pick<BackupSpaceDeps, 'isPackaged' | 'resourcesPath' | 'appRoot' | 'nativeBinding'> = {}
): AssetsDbHandle {
  const nativeBinding =
    bindingOptions.nativeBinding !== undefined
      ? bindingOptions.nativeBinding
      : resolveAssetsNativeBinding({
          isPackaged: bindingOptions.isPackaged ?? false,
          resourcesPath: bindingOptions.resourcesPath,
          appRoot: bindingOptions.appRoot
        }).nativeBinding
  return new Database(dbPath, { readonly: true, nativeBinding })
}

/**
 * 缺省取空间写锁。
 *
 * **为什么用 `acquireWriterLockFile` 而非 `acquireWorkspaceLock`**（§1.2 需勘察的落点，见回报）：
 * `acquireWorkspaceLock(root)`（`operationGate.ts:133`）会在取锁前 `mkdirSync(<root>/.mimir)`——
 * 这对**已存在**的空间根无害，但它还会 `realpathSync(root)` 并要求目录存在；而本层更愿意
 * **明确**两件事：① 锁路径 = `<spaceRoot>/.mimir/workspace.writer-lock`（与维护会话 `select()`
 * 取的锁**同名同址**，从而能检测「维护会话已持锁」的自锁情形）；② canonical root 用 `realpathSync`
 * 解析（与 `acquireWorkspaceLock` 一致）。故这里显式构造锁路径并委托 `acquireWriterLockFile`。
 *
 * ⚠️ `acquireWriterLockFile` 会校验锁父目录非符号链接且 canonical——若空间根/`.mimir` 形态异常，
 * 它会抛错，本层据此返回 `LOCK_UNAVAILABLE`（失败就失败，不猜残锁）。
 *
 * @param spaceRoot 空间根绝对路径。
 * @returns 锁句柄（含 `release()`）。
 */
export function defaultAcquireSpaceLock(spaceRoot: string): SpaceLockHandle {
  const lockPath = join(spaceRoot, '.mimir', WRITER_LOCK_NAME)
  // canonicalRoot 传 realpathSync 解析后的空间根（与 operationGate 的 canonical 语义对齐）。
  return acquireWriterLockFile(lockPath, spaceRoot)
}

/** 解析后的有效依赖（缺省值补齐）。 */
interface ResolvedDeps {
  readonly home: string
  readonly now: () => Date
  readonly resolveSpaces: (home: string) => SpacePathView[]
  readonly openAssetsDb: (dbPath: string) => AssetsDbHandle
  readonly createBackup: typeof createBackup
  readonly acquireSpaceLock: (spaceRoot: string) => SpaceLockHandle
  readonly writeAudit: (home: string, entry: MaintenanceAuditEntry) => void
  readonly emit: (stage: string, detail: string) => void
}

/** 把可选依赖补齐为有效依赖。 */
function resolveDeps(deps: BackupSpaceDeps): ResolvedDeps {
  return {
    home: deps.home,
    now: deps.now ?? (() => new Date()),
    resolveSpaces: deps.resolveSpaces ?? readRegistrySpacePaths,
    openAssetsDb:
      deps.openAssetsDb ??
      ((dbPath: string) =>
        openAssetsDbReadonly(dbPath, {
          isPackaged: deps.isPackaged,
          resourcesPath: deps.resourcesPath,
          appRoot: deps.appRoot,
          nativeBinding: deps.nativeBinding
        })),
    createBackup: deps.createBackup ?? createBackup,
    acquireSpaceLock: deps.acquireSpaceLock ?? defaultAcquireSpaceLock,
    writeAudit: deps.writeAudit ?? appendMaintenanceAudit,
    emit: (stage: string, detail: string) => {
      // 进度为**可选增强**：回调自身抛错绝不影响备份（最佳努力的可观测性）。
      try {
        deps.onProgress?.({ stage, detail })
      } catch {
        // 忽略：进度上报失败不是备份结果的一部分。
      }
    }
  }
}

/**
 * 写一条审计（**尽力而为**：审计失败绝不影响备份结果）。
 *
 * 为什么在本层再包一层 try/catch：`writeAudit` 在单测里可能被注入会抛错的假实现，
 * 而审计只是旁路——它失败不该把一次**成功**的备份扭成失败（对齐 `auditWriter` S-A3 纪律）。
 *
 * @param resolved 有效依赖。
 * @param entry 白名单形状的审计条目（调用方已脱敏）。
 */
function safeWriteAudit(resolved: ResolvedDeps, entry: MaintenanceAuditEntry): void {
  try {
    resolved.writeAudit(resolved.home, entry)
  } catch (error) {
    // 只报错误码（不报完整路径，避免 warn 日志本身泄漏本机路径）。
    console.warn('[backupService] 写审计失败', { code: (error as { code?: unknown }).code })
  }
}

/** 统一的失败返回（`ok:false`）。 */
function fail(code: string, detail: string): MaintenanceBackupResult {
  return { ok: false, code, detail }
}

/**
 * 执行一次逐空间完整备份（编排入口）。
 *
 * 顺序**严格**（设计 §1.1），每一步都有明确失败码：
 * ① 校验入参 → `INVALID_SPACE`（**未动盘：不取锁、不建目录、不写审计**）；
 * ② 只读解析注册表 → `REGISTRY_INVALID` / `SPACE_NOT_FOUND`（**未动盘**）；
 * ③ 取空间写锁 → `LOCK_UNAVAILABLE`（**未动盘：不写审计**）；
 * ④ 只读打开源库（不存在则允许无库）→ 打开失败 `BACKUP_FAILED`（**已动盘：写 failed 审计**）；
 * ⑤ 生成归档名 → ⑥ 建 `backups/` → ⑦ 调 `createBackup` 打包并原子发布 →（失败 `BACKUP_FAILED`）；
 * ⑧ 关库 + 释放锁（`finally`，无论成败）；
 * ⑨ 写审计（成功 / 失败都写，仅「未动盘」的前三步失败不写）；
 * ⑩ 返回**脱敏**结果。
 *
 * @param request 备份请求（**只含 `spaceId`**）。
 * @param deps 服务层依赖（`home` 必填；其余可注入）。
 * @returns 备份结果（成功含条目数 / 字节 / 归档 basename；失败只出 `{ok:false,code,detail}`）。
 */
export async function runSpaceBackup(
  request: MaintenanceBackupRequest,
  deps: BackupSpaceDeps
): Promise<MaintenanceBackupResult> {
  const resolved = resolveDeps(deps)

  // ── ① 校验入参（未动盘：不取锁、不建目录、不写审计） ──────────────────────
  const spaceId = request?.spaceId
  if (typeof spaceId !== 'string' || spaceId.trim() === '') {
    return fail('INVALID_SPACE', '未提供有效的空间标识，无法备份。')
  }

  // ── ② 只读解析注册表（未动盘） ────────────────────────────────────────────
  resolved.emit('resolving', '正在解析空间…')
  let spaces: SpacePathView[]
  try {
    spaces = resolved.resolveSpaces(resolved.home)
  } catch {
    // 注册表不可读 / 条目非法（readRegistrySpacePaths 抛 REGISTRY_INVALID）→ 零副作用返回。
    return fail('REGISTRY_INVALID', '注册表不可读或条目非法，无法定位空间。')
  }
  const space = spaces.find((candidate) => candidate.id === spaceId)
  if (!space) {
    return fail('SPACE_NOT_FOUND', '未找到该空间，可能已被移除或标识有误。')
  }

  // ── ③ 取锁（未动盘；§1.2：可用性检查，非并发防护） ──────────────────────
  resolved.emit('locking', '正在检查空间写锁…')
  let lock: SpaceLockHandle
  try {
    lock = resolved.acquireSpaceLock(space.path)
  } catch {
    // 锁被占用（EEXIST）/ 空间根形态异常 → 拒绝，**不写审计**（没动盘）。
    // 绝不按 PID / 年龄猜残锁（对齐 S6）：失败就失败。
    return fail('LOCK_UNAVAILABLE', '该空间正被占用（写锁已被持有），已跳过备份。')
  }

  // ── ④ 打开源库做一致快照（从这里开始已动盘） ────────────────────────────
  //     库**不存在** → 允许（assetsDb=null，归档不含库，结果 hasAssetsDb:false）。
  //     库**存在但打开失败** → BACKUP_FAILED（K6：绝不静默降级为「无库归档」）。
  const dbPath = join(space.path, ASSETS_DB_REL_PATH)
  let assetsDb: AssetsDbHandle | null = null
  let hasAssetsDb = false
  try {
    if (existsSync(dbPath)) {
      resolved.emit('snapshotting', '正在为资产库做一致快照…')
      // 打开失败（含原生绑定不可用）→ 抛出 → 外层 catch 收敛为 BACKUP_FAILED。
      assetsDb = resolved.openAssetsDb(dbPath)
      hasAssetsDb = true
    }
    // 记录「已进入动盘阶段」：此后任何失败都要写 outcome:'failed' 审计。
    return await packAndPublish(resolved, space, assetsDb, hasAssetsDb)
  } catch (error) {
    // ④ 打开失败 或 ⑦ 打包失败 → BACKUP_FAILED（已动盘，写 failed 审计）。
    const code = (error as { code?: unknown }).code
    const failureCode = typeof code === 'string' ? code : 'BACKUP_FAILED'
    resolved.emit('failed', '备份失败。')
    safeWriteAudit(resolved, {
      at: resolved.now().toISOString(),
      action: 'backup',
      outcome: 'failed',
      code: failureCode,
      counts: { entries: 0, totalBytes: 0, archiveBytes: 0, excluded: 0 },
      // labels 只放脱敏标识（空间名 / 归档 basename），**绝不含绝对路径**。
      labels: { space: space.name }
    })
    return fail('BACKUP_FAILED', '备份失败，未产出归档。')
  } finally {
    // ── ⑧ 关库 + 释放锁（无论成败；try/finally 防句柄 / 锁泄漏） ──────────
    if (assetsDb !== null) {
      try {
        assetsDb.close()
      } catch {
        // 关库失败不影响备份结果；不掩盖上方的真实失败原因。
      }
    }
    try {
      lock.release()
    } catch {
      // 释放锁失败不影响备份结果（锁的生命周期异常是另一类问题，不该改写备份结论）。
    }
  }
}

/**
 * 打包并原子发布归档（`runSpaceBackup` 的 ⑤–⑦ 步，拆出以保持主函数线性可读）。
 *
 * 前置：锁已持有、库已（可选）打开。本函数**不**负责关库 / 释放锁（由主函数 `finally` 统一处理）。
 *
 * @param resolved 有效依赖。
 * @param space 目标空间视图（含 name / path）。
 * @param assetsDb 已打开的源库句柄；无库时为 `null`。
 * @param hasAssetsDb 是否含库（回填结果）。
 * @returns 备份结果（成功分支）。
 */
async function packAndPublish(
  resolved: ResolvedDeps,
  space: SpacePathView,
  assetsDb: AssetsDbHandle | null,
  hasAssetsDb: boolean
): Promise<MaintenanceBackupResult> {
  // ── ⑤ 生成归档名（批次 5 规范） ─────────────────────────────────────────
  const archiveName = deriveArchiveName(space.name, resolved.now())
  const backupsDir = archiveDirectory(resolved.home)
  const destination = join(backupsDir, archiveName)
  // 暂存与 destination 同盘（`backups/.staging`）；理由见 `STAGING_DIR_NAME` 注释。
  const stagingDir = join(backupsDir, STAGING_DIR_NAME)

  // ── ⑥ 建归档目录（写路径，允许建目录；与只读扫描区分） ──────────────────
  mkdirSync(backupsDir, { recursive: true })

  // ── ⑦ 打包（createBackup 内部生成清单 → 快照注入 → 写暂存 → fsync → 原子 rename） ──
  resolved.emit('packing', '正在打包归档…')
  const result = await resolved.createBackup({
    root: space.path,
    // 同时给 destination 与 spaceName → packer 走「受管命名校验」分支（`packer.ts:124`）：
    //   `deriveArchiveName` 产出的名字天然满足 `isManagedArchive`，故校验自然通过。
    //   这条链路让「命名规范在打包路径上被强制落实」（K5：归档名不合规范 → 保留策略找不到）。
    destination,
    spaceName: space.name,
    stagingDir,
    assetsDb: assetsDb as unknown as Database.Database | null,
    // 库非空时**必给**相对路径（定位快照注入点）；无库时缺省（packer 不会用到）。
    assetsDbRelPath: assetsDb !== null ? ASSETS_DB_REL_PATH : undefined
  })

  resolved.emit('done', '备份完成。')

  // ── ⑨ 写成功审计（labels 只放空间名 + 归档 basename，绝不含绝对路径） ──
  safeWriteAudit(resolved, {
    at: resolved.now().toISOString(),
    action: 'backup',
    outcome: 'ok',
    counts: {
      entries: result.entries,
      totalBytes: result.totalBytes,
      archiveBytes: result.archiveBytes,
      excluded: result.excluded.length
    },
    labels: { space: space.name, archive: basename(archiveName) }
  })

  // ── ⑩ 返回脱敏结果（createBackup 的 destination 是绝对路径 → **只取 basename**） ──
  return {
    ok: true,
    spaceId: space.id,
    name: space.name,
    archiveName: basename(archiveName),
    entries: result.entries,
    totalBytes: result.totalBytes,
    archiveBytes: result.archiveBytes,
    excluded: result.excluded.length,
    hasAssetsDb
  }
}
