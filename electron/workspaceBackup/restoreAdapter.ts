/**
 * 恢复适配器（I6 批次 3 · 第 4 块）。
 *
 * 职责：把 `restoreRunner.RestoreSteps` 的注入步骤接到**真实模块**上。
 *
 * 为什么单独一层：
 * - `restoreRunner` 是**零 IO 纯编排**（步骤全部注入，便于用假实现断言失败语义的副作用）。
 *   真实文件系统 / SQLite / 注册表写入**不应该**出现在编排层里，否则那条编排就不可测了。
 * - 各真实模块的签名彼此不等价（如 `extractToStaging` 返回 `ExtractResult` 而编排只要条目数；
 *   `planRestore` 需要 `targetExists` 与 `verified` 而 `RestoreInput` 里没有），
 *   这些**差异必须收敛在适配器**，不能污染编排契约。
 *
 * 纪律：
 * - 本文件是**唯一**允许触碰 fs / SQLite / 注册表的地方（在批次 3 的恢复链路内）。
 * - 不改 `RestoreSteps` 的形状；`targetCreated` 仍是可选探针。
 * - 不调用 `loadStore()`、不改 `active`/`default` 指针——注册只走 `appendWorkspaceRecord`。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RestoreError } from './restoreContracts'
import { assertRestoredResearchIntegrity } from '../library/research/integrity'
import { assertRestoredPlanningIntegrity } from '../researchPlanning/integrity'
import { planRestore } from './restorePlan'
import { verifyBackup } from './verify'
import { cleanupStagingRoot, createStagingRoot } from './stagingRoot'
import { extractToStaging } from './extract'
import { remapSpaceStore } from './spaceStoreRemap'
import type { RemapAuditReport } from './remapAudit'
import { publishStagedSpace } from './publish'
import { appendWorkspaceRecord, buildRegistryAppendInput, writeRegistryAtomic } from './registryAppend'
import type { RestoreInput, RestoreSteps } from './restoreRunner'

/** 空间层 store 在暂存根内的相对路径。 */
const SPACE_STORE_REL = ['.mimir', 'store.json'] as const
/** 空间控制目录名（锁所在处；`acquireWorkspaceLock` 同口径）。 */
const MIMIR_DIR = '.mimir'
/** 新空间写锁文件名（`acquireWorkspaceLock` 的默认名）。 */
const WORKSPACE_LOCK_NAME = 'workspace.writer-lock'
/** 资产库在暂存根内的相对路径（存在才校验，不存在则跳过）。 */
const ASSETS_DB_REL = ['.mimir', 'assets', 'assets.db'] as const

export interface RestoreAdapterOptions {
  /** 时钟（可注入以便测试确定性）。缺省 `new Date().toISOString()`。 */
  readonly now?: () => string
  /**
   * 资产库完整性校验钩子（**可选**）。
   *
   * 不注入则**跳过** `assets.db` 的完整性校验（只校验空间层 `store.json`）。
   * 之所以做成钩子而不是直接打开：真实 Electron 下打开 SQLite 需要经
   * `electron/assets/nativeBinding.ts` 解析原生绑定（依赖 `app.isPackaged`），
   * 把那份耦合写进适配器会让本层无法脱离 Electron 被单测。
   * → 由 T05 主进程接线注入真实实现。
   */
  readonly checkAssetsIntegrity?: (dbPath: string) => Promise<void>
  /**
   * **目标是否在本次操作开始前就已存在**（§2.1 落点不可覆盖的判据）。
   *
   * ⚠️ 生产接线**必须**注入，否则 `inspect` 只能退化为实时 `existsSync(targetRoot)`——
   * 而调用方为了按 §4.2 S5 取写锁，往往不得不**先把目标目录建出来**（见
   * `restoreMain.runMaintenanceRestore` 的函数头注释），届时实时 stat 永远为真，
   * 每次恢复都会以 `TARGET_EXISTS` 失败。
   *
   * 缺省 `undefined` = 走实时 `existsSync`（保持本层可脱离 `restoreMain` 单测的旧行为，
   * 且对「调用方自己保证目录不存在」的用法无害）。
   */
  readonly targetExistedBefore?: boolean
  /**
   * 解压到暂存根**之后、发布之前**对暂存根取新空间写锁（§4.2 S5）。
   *
   * 为什么锁建在**暂存根**内而不是目标目录：
   * - 目标目录此刻**尚不存在**，且 §2.1 要求它必须不存在（publish 靠原子 `rename` 落地）；
   * - 暂存根随后被 `rename` 成目标 → 锁**随目录迁移**到 `<targetRoot>/.mimir/`，
   *   于是「写新空间目录时已持其写锁」依然成立。
   *
   * ⚠️ 调用方必须用**写完即关句柄**的获取器（`acquireMigratableWriterLock`）：
   * Windows 下 `renameSync` 内含打开句柄文件（或目录）会 `EPERM`（实测）。
   * 返回一个 `release()` 供失败清理使用。
   */
  readonly lockStagingRoot?: (stagingRoot: string) => { release(): void }
}

/** 读取并解析暂存根内的空间层 store.json。 */
function readStagedSpaceStore(stagingRoot: string): Record<string, unknown> {
  const storePath = join(stagingRoot, ...SPACE_STORE_REL)
  let raw = ''
  try {
    raw = readFileSync(storePath, 'utf8')
  } catch (error) {
    throw new RestoreError('RECHECK_FAILED', `读取暂存空间层 store.json 失败：${storePath}（${(error as Error).message}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RestoreError('RECHECK_FAILED', `暂存空间层 store.json 不是合法 JSON：${storePath}（${(error as Error).message}）`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RestoreError('RECHECK_FAILED', `暂存空间层 store.json 顶层不是 JSON 对象：${storePath}`)
  }
  return parsed as Record<string, unknown>
}

/**
 * 构造一套接在真实模块上的恢复步骤。
 *
 * ⚠️ 一次恢复的各步骤**必须串行**（`runRestore` 逐步 `await` 保证了这一点）：
 * `inspect` 会暂存本次的 staging token 供 `createStaging` 消费，并发恢复会互相覆盖。
 */
export function createRestoreSteps(options: RestoreAdapterOptions = {}): RestoreSteps {
  const nowIso = options.now ?? (() => new Date().toISOString())
  const checkAssetsIntegrity = options.checkAssetsIntegrity
  const targetExistedBefore = options.targetExistedBefore
  const lockStagingRoot = options.lockStagingRoot

  /** inspect 生成、createStaging 消费的本次暂存 token。 */
  let pendingToken = ''
  /** 本次实际使用的暂存根（`targetCreated` 探针判据之一）。 */
  let activeStaging = ''
  /** 建在暂存根内的新空间写锁（§4.2 S5；由 `lockStagingRoot` 提供，供失败清理释放）。 */
  let stagingLock: { release(): void } | null = null

  return {
    async inspect(input: RestoreInput) {
      // 目标是否已存在由**调用方**给出优先：`planRestore` 是零 IO 纯函数，
      // 而调用方可能为了取写锁而先建了空目录——此时实时 stat 会把它误判成「用户既有目录」。
      // 未注入时退回实时 stat（见 RestoreAdapterOptions.targetExistedBefore 注释）。
      const targetExists = targetExistedBefore ?? existsSync(input.targetRoot)
      const verified = await verifyBackup(input.archivePath)
      pendingToken = randomUUID()
      return planRestore({
        archivePath: input.archivePath,
        targetRoot: input.targetRoot,
        targetExists,
        verified: {
          entries: verified.entries,
          totalBytes: verified.totalBytes,
          formatVersion: verified.formatVersion
        },
        stagingToken: pendingToken
      })
    },

    async createStaging(input: RestoreInput) {
      // 与 inspect 用**同一个** token，保证暂存根路径与计划一致。
      const token = pendingToken !== '' ? pendingToken : randomUUID()
      pendingToken = token
      const staging = createStagingRoot(input.targetRoot, token)
      activeStaging = staging.root
      // §4.2 S5 锁先行：**解压任何内容之前**就在暂存根内建锁（暂存根已存在，锁的父目录
      // `<staging>/.mimir` 由获取器自行 mkdir）。锁随发布 rename 迁移到目标目录，
      // 因此「写新空间目录时已持其写锁」成立，而目标目录始终无需预先存在。
      if (lockStagingRoot !== undefined) {
        stagingLock = lockStagingRoot(staging.root)
      }
      return staging.root
    },

    async extract(input: RestoreInput, stagingRoot: string) {
      const result = await extractToStaging({ archivePath: input.archivePath, stagingRoot })
      return result.files
    },

    /**
     * T03 改写（§3.4 a/b）：读暂存副本 → 白名单改写 → 原子写回。
     *
     * 这是整条链路里**唯一**的复合 IO 步骤；编排层只认 `RemapAuditReport`。
     *
     * ⚠️ **空间层 store.json 不存在 ≠ 失败**（设计 §3.5：「允许结论是『零处需重写』，
     * 不算失败」）。一个刚创建、尚未写入任何内容的科研空间本来就没有 `.mimir/store.json`
     * （见 `store.ts` 的 `spaceRoot()` 兜底语义）；若把它当 `RECHECK_FAILED`，
     * 就会让**空空间永远无法恢复**——这是本函数在 T05 联调时被真实用例抓到的缺陷。
     * 故：文件缺失 → 视为空 store（`{}`），不写盘、不产生改写，直接返回空报告。
     */
    async remap(input: RestoreInput, stagingRoot: string): Promise<RemapAuditReport> {
      const storePath = join(stagingRoot, ...SPACE_STORE_REL)
      if (!existsSync(storePath)) {
        // 空 store：白名单一项都没命中（也无可改写处），审计报告如实为空。
        return { found: [], rewritten: [], skipped: [], observed: [] }
      }
      const store = readStagedSpaceStore(stagingRoot)
      const { store: remapped, report } = remapSpaceStore(store, input.oldRoot, input.targetRoot)
      // 原子写回（temp + rename）。注：该辅助在 POSIX 下给 0600，比 store.ts 对空间层的
      // 默认 0644 更严——属收紧暴露面，Windows 上 chmod 被跳过无影响。
      writeRegistryAtomic(storePath, remapped)
      return report
    },

    async recheck(_input: RestoreInput, stagingRoot: string) {
      assertRestoredPlanningIntegrity(stagingRoot)
      assertRestoredResearchIntegrity(stagingRoot)
      // ① 空间层配置：**存在才需要**校验可解析（remap 刚写过就再读一次确认落盘成立）。
      //    不存在是合法状态（空空间，见 remap 注释），此时无从校验、也不该失败。
      if (existsSync(join(stagingRoot, ...SPACE_STORE_REL))) {
        readStagedSpaceStore(stagingRoot)
      }
      // ② 资产库：存在就必须真验；未注入钩子则跳过（理由见 RestoreAdapterOptions 注释）。
      const dbPath = join(stagingRoot, ...ASSETS_DB_REL)
      if (!existsSync(dbPath)) return
      if (checkAssetsIntegrity === undefined) return
      await checkAssetsIntegrity(dbPath)
    },

    async publish(input: RestoreInput, stagingRoot: string) {
      await publishStagedSpace(stagingRoot, input.targetRoot)
      // rename 已把暂存根（连同其内的 `.mimir/workspace.writer-lock`）搬到目标目录。
      // 锁对象记录的仍是**旧路径**，必须迁移到新路径，否则 `release()` 会 ENOENT。
      // 这是 `lockStagingRoot` 必须返回可迁移锁对象（`acquireMigratableWriterLock`）的原因。
      if (stagingLock !== null && 'migrate' in stagingLock) {
        const migrated = join(input.targetRoot, MIMIR_DIR, WORKSPACE_LOCK_NAME)
        ;(stagingLock as { migrate(next: string): void }).migrate(migrated)
      }
    },

    /**
     * 「目标是否确由本操作创建」的探针（供 `publishing` 失败时决定回收范围）。
     *
     * 判据的可推断性：rename 若真的发生，暂存根会被 rename **消费掉**（消失），目标随即出现。
     * - 预检失败（`TARGET_EXISTS` / `UNSAFE_ENTRY` / 暂存根不存在）→ 暂存根**仍在** → `false`；
     * - rename 成功但发布后复核失败 → 暂存根**已消失**且目标存在 → `true`（确由本操作创建）。
     *
     * ⚠️ 绝不能用裸 `existsSync(targetRoot)` 代替：`TARGET_EXISTS` 场景下目标是**用户既有的目录**，
     * 本操作从未创建它，按「存在」判定会让 abort 删掉用户目录（违反 §1.3 规则 2）。
     * 这里的 `existsSync(activeStaging)` 正是把「用户既有的」和「我们造的」区分开的关键前提。
     */
    async targetCreated(input: RestoreInput) {
      if (activeStaging === '') return false
      if (existsSync(activeStaging)) return false
      return existsSync(input.targetRoot)
    },

    async register(input: RestoreInput, spaceId: string) {
      const outcome = appendWorkspaceRecord(
        input.homeDir,
        buildRegistryAppendInput({ id: spaceId, name: input.spaceName, path: input.targetRoot }, nowIso)
      )
      return { appended: outcome.appended }
    },

    async cleanupStaging(stagingRoot: string) {
      // 先释放暂存根内的写锁再删目录：锁文件就在待删目录里，若不显式释放会留下
      // 「锁凭据随目录被删」的状态——虽不致命（目录都没了），但会让会话以为仍持锁。
      releaseStagingLockBestEffort()
      cleanupStagingRoot(stagingRoot)
    }
  }

  /** 释放暂存根锁（尽力而为；失败不改变主流程语义，交由会话自身的阻断机制兜底）。 */
  function releaseStagingLockBestEffort(): void {
    const lock = stagingLock
    if (lock === null) return
    stagingLock = null
    try {
      lock.release()
    } catch {
      // 锁文件已随目录消失（ENOENT）或已被替换：两者都不该让清理失败。
    }
  }
}
