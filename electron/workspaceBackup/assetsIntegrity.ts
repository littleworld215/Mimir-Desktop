/**
 * 资产库完整性校验（I6 批次 3 · 第 5 块 · T05）。
 *
 * 职责：为 `createRestoreSteps` 的 `checkAssetsIntegrity` 钩子提供**真实实现**。
 * 批次 3 设计 §3.4 步骤 c 要求对暂存副本做「JSON / 数据库 / 外键 / 摘要」二次校验，
 * 但 `recheck.ts` 从未落地；`restoreAdapter` 只好把该步做成可注入钩子（默认跳过）。
 * **不注入 = 带 `assets.db` 的空间恢复时不验完整性**——这正是本文件要补上的缺口。
 *
 * 为什么只读打开就够（实测结论，非推断）：
 * 归档里的 `assets.db` 是批次 2 `packer` 用 `db.backup()` 产出的**一致快照**
 * （`packer.ts:98`）。虽然源库是 WAL 模式（`assets/store.ts:68`），
 * `backup()` 会把页写回主库、把头部的 write/read version 字节复位为非 WAL（均为 2），
 * 故快照本身**不是** WAL 库，只读打开不需要写 `-shm`/`-wal`。
 * → 用 `{ readonly: true }` 打开即可，**绝不**让待验收的暂存副本可写。
 *
 * 纪律：
 * - **只读**：`readonly: true`；任何校验路径都不得写入暂存副本。
 * - **复用 schema 真源**：期望表集合取自 `ASSETS_DDL`（`electron/assets/schema.ts`），
 *   不手抄表名——手抄会在下一次 schema 变更时静默失效。
 * - **失败即阻断**：任一检查不通过一律抛 `RestoreError('INTEGRITY_FAILED')`，
 *   由 `restoreRunner` 归入 `verifying` 阶段失败。**绝不**「部分通过」。
 * - 原生绑定的解析交给 `electron/assets/nativeBinding.ts`（依赖 `app.isPackaged`），
 *   本文件把 `isPackaged`/`resourcesPath` 作为参数传入，从而**可脱离 Electron 单测**。
 */

import Database from 'better-sqlite3'

import { RestoreError } from './restoreContracts'
import { resolveAssetsNativeBinding } from '../assets/nativeBinding'
import { ASSETS_DDL } from '../assets/schema'

/** 打开选项（注入以便单测与真实 Electron 各走各的绑定解析）。 */
export interface AssetsIntegrityOptions {
  /** Electron `app.isPackaged`（缺省 `false`：开发模式/Node 测试用默认绑定）。 */
  readonly isPackaged?: boolean
  /** Electron `process.resourcesPath`（打包后必需）。 */
  readonly resourcesPath?: string
  /** 开发模式应用根（定位 `.native/` 缓存）；缺省 `process.cwd()`。 */
  readonly appRoot?: string
  /** 单测可直接给一个已解析的 `nativeBinding`，跳过解析。 */
  readonly nativeBinding?: string
}

/**
 * 期望的表名集合：从 `ASSETS_DDL` 里 `CREATE TABLE <name>` 语句中提取。
 *
 * 为什么改从 DDL 解析而不是用 `sqlite_master` 对比：
 * 真实库的 `sqlite_master` 含 `sqlite_sequence`、索引、触发器（如 `asset_version`
 * 的 append-only 触发器）等；「实际 == 期望」这种全等比对会把正常库判成损坏。
 * 而 `ASSETS_DDL` 正是**建库真源**，只取其 `CREATE TABLE` 名，语义精确且随 schema 自动跟进。
 */
export function expectedTableNames(ddl: readonly string[] = ASSETS_DDL): string[] {
  const names = new Set<string>()
  for (const statement of ddl) {
    // 支持 `CREATE TABLE foo (...)` / `CREATE TABLE IF NOT EXISTS "foo" (...)`。
    const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*|"[^"]+"|`[^`]+`|\[[^\]]+\])/i.exec(statement)
    if (match === null) continue
    const raw = match[1]
    names.add(raw.replace(/^["'`\[]|["'`\]]$/g, ''))
  }
  return [...names].sort()
}

/** 解析原生绑定；测试可显式传入以跳过 `app.isPackaged` 依赖。 */
function resolveBinding(options: AssetsIntegrityOptions): string | undefined {
  if (options.nativeBinding !== undefined) return options.nativeBinding
  return resolveAssetsNativeBinding({
    isPackaged: options.isPackaged ?? false,
    resourcesPath: options.resourcesPath,
    appRoot: options.appRoot
  }).nativeBinding
}

/**
 * 对暂存副本 `assets.db` 做完整性校验。
 *
 * 检查项（任一不通过即抛 `INTEGRITY_FAILED`）：
 * 1. 只读打开成功（含原生绑定可解析）；
 * 2. `PRAGMA integrity_check` == `ok`（页级/索引级结构）；
 * 3. `PRAGMA foreign_key_check` 为空（外键真成立，不只是「schema 里声明了」）；
 * 4. 期望表全部存在（对着 `ASSETS_DDL` 核，缺表说明归档内容被截断或被换过）。
 *
 * @throws RestoreError `INTEGRITY_FAILED`
 */
export async function checkRestoredAssetsIntegrity(
  dbPath: string,
  options: AssetsIntegrityOptions = {}
): Promise<void> {
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, nativeBinding: resolveBinding(options) })
  } catch (error) {
    throw new RestoreError(
      'INTEGRITY_FAILED',
      `暂存副本资产库无法只读打开：${dbPath}（${(error as Error).message}）`
    )
  }

  try {
    const integrity = db.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      throw new RestoreError('INTEGRITY_FAILED', `资产库完整性检查失败（${String(integrity)}）：${dbPath}`)
    }

    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[]
    if (!Array.isArray(foreignKeyViolations) || foreignKeyViolations.length !== 0) {
      throw new RestoreError(
        'INTEGRITY_FAILED',
        `资产库外键检查失败（${foreignKeyViolations.length} 处违规）：${dbPath}`
      )
    }

    // 只读连接下 `sqlite_master` 可查（不触发任何写）。
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    const actual = new Set(rows.map((row) => row.name))
    const missing = expectedTableNames().filter((name) => !actual.has(name))
    if (missing.length !== 0) {
      throw new RestoreError(
        'INTEGRITY_FAILED',
        `资产库缺少期望的数据表（${missing.join('、')}）：${dbPath}`
      )
    }
  } catch (error) {
    if (error instanceof RestoreError) throw error
    throw new RestoreError('INTEGRITY_FAILED', `资产库校验异常：${dbPath}（${(error as Error).message}）`)
  } finally {
    try {
      db.close()
    } catch {
      // 只读连接关闭失败不影响校验结论；不掩盖上方的真实失败原因。
    }
  }
}
