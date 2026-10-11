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
/** 资产库在暂存根内的相对路径（存在才校验，不存在则跳过）。 */
const ASSETS_DB_REL = ['assets', 'assets.db'] as const

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

  /** inspect 生成、createStaging 消费的本次暂存 token。 */
  let pendingToken = ''
  /** 本次实际使用的暂存根（`targetCreated` 探针判据之一）。 */
  let activeStaging = ''

  return {
    async inspect(input: RestoreInput) {
      // 目标是否已存在由**调用方 stat**得到：`planRestore` 是零 IO 纯函数。
      const targetExists = existsSync(input.targetRoot)
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
     */
    async remap(input: RestoreInput, stagingRoot: string): Promise<RemapAuditReport> {
      const storePath = join(stagingRoot, ...SPACE_STORE_REL)
      const store = readStagedSpaceStore(stagingRoot)
      const { store: remapped, report } = remapSpaceStore(store, input.oldRoot, input.targetRoot)
      // 原子写回（temp + rename）。注：该辅助在 POSIX 下给 0600，比 store.ts 对空间层的
      // 默认 0644 更严——属收紧暴露面，Windows 上 chmod 被跳过无影响。
      writeRegistryAtomic(storePath, remapped)
      return report
    },

    async recheck(_input: RestoreInput, stagingRoot: string) {
      // ① 空间层配置必须可解析（remap 刚写过，这里再读一次确认落盘结果成立）。
      readStagedSpaceStore(stagingRoot)
      // ② 资产库：存在就必须真验；未注入钩子则跳过（理由见 RestoreAdapterOptions 注释）。
      const dbPath = join(stagingRoot, ...ASSETS_DB_REL)
      if (!existsSync(dbPath)) return
      if (checkAssetsIntegrity === undefined) return
      await checkAssetsIntegrity(dbPath)
    },

    async publish(input: RestoreInput, stagingRoot: string) {
      await publishStagedSpace(stagingRoot, input.targetRoot)
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
      cleanupStagingRoot(stagingRoot)
    }
  }
}
