/**
 * 维护模式下的恢复服务层（I6 批次 3 · 第 5 块 · T05）。
 *
 * 职责：把「用户在维护窗口选了一份归档」翻译成一次**持锁、串行、可被观测**的
 * `runRestore`。它是 `restoreRunner`（纯编排）/ `restoreAdapter`（真实步骤）/
 * 维护窗口（`maintenanceMain`）之间的**装配点**，也是本批次唯一负责以下三件事的地方：
 *
 * 1. **归档内旧根推导**：`oldRootFromArchive`（`restoreArchive.ts`）。
 * 2. **真实完整性钩子注入**：`checkRestoredAssetsIntegrity`（`assetsIntegrity.ts`）。
 *    —— 不注入就会让带 `assets.db` 的空间恢复时**跳过**完整性校验（设计 §3.4 c 的缺口，
 *    这正是 T05 必须补齐、且必须在**生产接线**里补而非只在测试里补的原因）。
 * 3. **写锁与串行**：恢复全程持有 `WorkspaceWriterSession`（registry 锁 + 新空间锁）；
 *    并发恢复一律拒绝（`restoreAdapter` 的 staging token 是单例串行假设，见其注释）。
 *
 * 纪律（对应 `restoreRunner.ts` 文件头 6 条，逐条落到本文件）：
 * - 纪律 4「控制不可嵌套」：本文件**绝不**调 `workspaces:*` 等被 `installWorkspaceIpcGate`
 *   包进 `runControl` 的通道；发布 / 注册走适配器里的直接函数，不经 IPC。
 * - §4.2 S5「锁先行」：写注册表前必须已持 `registry.writer-lock`（由 `maintenanceMain`
 *   构造 `WorkspaceWriterSession` 时即持有）、写新空间目录前已持该目录 `workspace.writer-lock`
 *   —— 做法是**在暂存根内先取锁**（`lockStagingRoot`），再解压发布；发布那次原子 `rename`
 *   会把锁文件一并带到目标目录（`<targetRoot>/.mimir/workspace.writer-lock`），于是
 *   「写新空间目录时已持其写锁」成立，而**目标目录始终无需预先存在**。详见函数头注释。
 * - §4.2 S4：注册表原子写由 `registryAppend.writeRegistryAtomic` 负责（本文件不直接写）。
 *
 * `homeDir` 必须由调用方给出（生产 = 真实 `homedir()`）：`restoreAdapter.register` 会走
 * `appendWorkspaceRecord(input.homeDir, …)` **真正把新空间登记进本机注册表**。为什么放在
 * 编排内、而不是等 `runMaintenanceRestore` 返回后再由 `maintenanceMain` 补写：
 * 若把注册挪到编排之外，`runMaintenanceRestore` 会在「暂存已发布、注册未发生」时返回
 * `done` —— 那是一句**谎报**（用户看到成功，注册表里却没有这个空间），且注册失败再也无法
 * 归因到 `registering` 阶段。注册留在编排内，失败即 `failed`（`cleanup` 带 `createdTarget`，
 * 供 abort 回收已发布目录），语义才闭环。
 *
 * 注册表锁由 `maintenanceMain` 构造 `WorkspaceWriterSession` 时即持有（§4.2 S5 前半段），
 * 本层只负责传真实 home；测试用合成 home（`restoreRunner.test.ts` 的 `'C:/synthetic-home'`
 * 就是此约定），**绝不**写真实 `~/.mimir`。
 */

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

import { runRestore, type RestoreInput, type RestoreOutcome, type RestoreSteps } from './restoreRunner'
import { createRestoreSteps, type RestoreAdapterOptions } from './restoreAdapter'
import { oldRootFromArchive, readArchiveManifest } from './restoreArchive'
import { checkRestoredAssetsIntegrity, type AssetsIntegrityOptions } from './assetsIntegrity'
import { prepareStagedAssets } from './assetsRestore'
import { stagingPathFor } from './stagingRoot'
import type { ManifestEntry } from './manifest'
import { RestoreError } from './restoreContracts'

/** 维护窗口可见的归档候选。 */
export interface RestoreArchiveCandidate {
  /** 归档绝对路径。 */
  readonly path: string
  /** 展示用文件名。 */
  readonly name: string
  /** 归档字节数。 */
  readonly bytes: number
  /** 最后修改时刻（ISO）。 */
  readonly modifiedAt: string
  /** 该归档是否含可推导的旧空间根（决定 `pdfPath` 能否自动改写到新空间）。 */
  readonly remappable: boolean
}

/** 恢复请求（全部由主进程规范化，渲染层不拼路径 —— §4.2 S7）。 */
export interface RestoreRequest {
  /** 归档绝对路径。 */
  readonly archivePath: string
  /** 新空间根绝对路径：**必须不存在**（§2.1 拒绝覆盖）。 */
  readonly targetRoot: string
  /** 新空间名（登记用）。 */
  readonly spaceName: string
}

/** 恢复进度回调（U4：沿用维护窗口 IPC，不新增依赖）。 */
export type RestoreProgressReporter = (progress: {
  readonly stage: string
  readonly detail: string
}) => void

/**
 * `runMaintenanceRestore` 的依赖（注入以便单测，不启动 Electron）。
 *
 * ⚠️ 会话接口**只要一个 `assertUsable()`**，这是 T05 收口的直接结果：
 * 早先版本要 `prepareNewSelection(root)` 来「建目标目录 + 取新空间写锁」，但那与
 * §2.1「目标必须不存在」互斥（详见 `runMaintenanceRestore` 函数头注释的冲突推导）。
 * 现在写新空间的锁改由适配器的 `lockStagingRoot` 在**暂存根内**取、随发布 `rename`
 * 迁到目标，故编排层**不再需要**会话去碰目标目录；会话退化为纯粹的
 * 「维护窗口是否还活着」健康检查（`assertUsable`），并由
 * `maintenanceMain` 在构造时即持有 `registry.writer-lock`（§4.2 S5 的前半段）。
 */
export interface MaintenanceWriterSession {
  /** 会话是否仍可用（维护窗口未被销毁、注册表锁仍持有）。 */
  assertUsable(): void
}

export interface MaintenanceRestoreDeps {
  /** 主进程内部持久化上下文，不来自渲染层。 */
  readonly beginOperation?: () => { id: string; spaceId: string; decorate(steps: RestoreSteps, input: RestoreInput): RestoreSteps }
  /** 维护模式持有的写者会话（本层只用它做健康检查；registry 锁在构造时已持有）。 */
  readonly session: MaintenanceWriterSession
  /**
   * 注册表 home（**生产 = 真实 `homedir()`**，测试 = 合成目录）。
   *
   * 恢复成功后新空间会被**真正登记**到这里（经 `appendWorkspaceRecord`，S1–S10）。
   * 测试必须传合成 home，否则会往真实 `~/.mimir/store.json` 追加记录。
   */
  readonly homeDir: string
  /**
   * 在**暂存根内**取新空间写锁（§4.2 S5），返回一个可释放、随发布 `rename` 可迁移的锁对象。
   *
   * **必传**：生产用 `acquireMigratableWriterLock`（`operationGate.ts`）包装。理由见
   * `RestoreAdapterOptions.lockStagingRoot` 的长注释：锁必须先于解压建立在暂存根里，
   * 再由发布那次 `rename` 带到目标目录。
   */
  readonly lockStagingRoot: (stagingRoot: string) => { release(): void; migrate?(next: string): void }
  /** 目标是否已被占用（缺省用 `existsSync`）。 */
  readonly targetExists?: (path: string) => boolean
  /** 归档是否存在（缺省用 `existsSync`）。 */
  readonly archiveExists?: (path: string) => boolean
  /** 某路径是否是**已存在**的目录（缺省用 `existsSync` + `statSync().isDirectory()`）。 */
  readonly isExistingDirectory?: (path: string) => boolean
  /**
   * 某路径自身是否是符号链接/junction（缺省用 `lstatSync().isSymbolicLink()`，**不跟随链接**）。
   *
   * 注入点存在理由：验证「目标父目录为符号链接 → 拒绝」这条路径，且避免测试依赖
   * 沙箱能否真正创建 junction（真实 junction 创建需权限，判定语义亦与真机有差异）。
   */
  readonly isSymbolicLinkPath?: (path: string) => boolean
  /**
   * 读取归档清单（缺省 `readArchiveManifest`）。
   *
   * 注入点存在理由：验证「早期归档无 `sourceRoot` → 退化为不改写」这条**真实退化路径**，
   * 需要一份不含该字段的归档；而 `createBackup` 现在总会写入它，只能靠注入模拟。
   */
  readonly readManifest?: (archivePath: string) => Promise<{ sourceRoot?: string; sourceSpaceId?: string; entries: ManifestEntry[] }>
  /** 进度回调。 */
  readonly onProgress?: RestoreProgressReporter
  /** 适配器附加选项（单测注入假完整性钩子）。 */
  readonly adapter?: RestoreAdapterOptions
  /** 仅由维护主进程传入实际打包环境，不接受渲染层指定绑定路径。 */
  readonly assetsIntegrityOptions?: AssetsIntegrityOptions
}

/** 列出某目录下的归档候选（**只读**，不递归、不建目录）。 */
export async function listRestoreArchives(directory: string): Promise<RestoreArchiveCandidate[]> {
  if (!existsSync(directory)) return []
  const out: RestoreArchiveCandidate[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!/\.zip$/i.test(entry.name)) continue
    const path = join(directory, entry.name)
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(path)
    } catch {
      // 单个条目 stat 失败（并发删除/权限）：跳过，不影响其余候选。
      continue
    }
    let remappable = false
    try {
      // ⚠️ 判据是「归档清单是否含**绝对**源根 `sourceRoot`」，**不是**能否推导出相对根：
      // T03 的 `matchRootPrefix` 要求旧根为绝对路径，相对根永不命中（实测 `rewritten=0`）。
      // 详见 restoreArchive.ts 文件头的实测更正。
      const manifest = await readArchiveManifest(path)
      remappable = typeof manifest.sourceRoot === 'string' && manifest.sourceRoot.trim() !== ''
    } catch {
      // 清单不可读（损坏 / 非本应用归档）：**仍然列出**，但标注不可自动改写。
      // 隐藏用户文件比展示一个「需要人工确认」的条目更糟；确切拒绝理由由验包阶段给出。
      remappable = false
    }
    out.push({
      path: normalize(path),
      name: entry.name,
      bytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      remappable
    })
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

/**
 * 构造生产用的恢复步骤：真适配器 + **真实**完整性钩子 + **暂存根内写锁**。
 *
 * 这是本批次唯一「把 `checkAssetsIntegrity` 真正接上」的地方。测试可自行传入
 * `adapter.checkAssetsIntegrity` 覆盖；生产必须走本函数，否则带 `assets.db` 的空间
 * 恢复时不会做完整性校验（静默降级，属设计 §7 K11「沙箱绿冒充真实绿」同类风险）。
 *
 * @param targetExistedBefore **必传**：目标在本次操作开始前是否已存在。
 *   必须由调用方在**任何建目录动作之前**取真值（见 `runMaintenanceRestore` 函数头注释）。
 * @param lockStagingRoot **必传**：在暂存根内取新空间写锁（§4.2 S5），见 deps 注释。
 */
export function createMaintenanceRestoreSteps(
  targetExistedBefore: boolean,
  lockStagingRoot: (stagingRoot: string) => { release(): void; migrate?(next: string): void },
  adapter: RestoreAdapterOptions = {},
  assetsIntegrityOptions: AssetsIntegrityOptions = {}
) {
  return createRestoreSteps({
    prepareAssets: (stagingRoot: string) => prepareStagedAssets(stagingRoot, assetsIntegrityOptions),
    checkAssetsIntegrity: (dbPath: string) => checkRestoredAssetsIntegrity(dbPath, assetsIntegrityOptions),
    targetExistedBefore,
    // 调用方的 lockStagingRoot 优先于 adapter 里可能带的同名字段（后者供单测覆盖）。
    lockStagingRoot: adapter.lockStagingRoot ?? lockStagingRoot,
    ...adapter
  })
}

/**
 * 执行一次维护模式恢复：**校验 → 检查父目录 → 推导旧根 → 编排（暂存根内取锁）**。
 *
 * ⚠️ **「锁先行」与「落点不可覆盖」曾在这里顶牛**，本函数现在的形态就是化解的结论。
 * 冲突原貌（值得留档，因为直读设计文档会得出**不可行**的字面实现）：
 * - §4.2 S5 要求写新空间目录前已持其写锁；而当时唯一可用的取锁器
 *   （`WorkspaceWriterSession.prepareNewSelection` / `acquireWriterLockFile`）要
 *   `realpathSync(root)`，**要求目录已存在**，于是必须先建目录。
 * - §2.1/§2.3 又要求「目标不存在」才允许恢复，且 `planRestore` 在
 *   `targetExists === true` 时硬拒绝（`TARGET_EXISTS`）。
 * - 若照字面写「先建目录 → 再验包」，`inspect` 的实时 stat 永远为真 → **每次恢复都必然
 *   `TARGET_EXISTS` 失败**；即便绕开 stat，`publish` 的 `renameSync` 也硬拒绝已存在的目标
 *   → **发布必然失败**。两条路都被实测堵死（`restoreMain.test.ts` 抓到前者，探针抓到后者）。
 *
 * 化解：**锁不再建在目标目录，而是建在暂存根内、随发布那次 `rename` 迁移过去**。
 * - 目标目录因此**始终由我们来创建**（publish 的原子 rename），从不预先存在 →
 *   §2.1/§2.3 字面要求天然满足，无需 `targetExistedBefore` 之类的注入来「骗过」预检。
 * - 锁先行仍成立：解压前锁已在暂存根内；rename 把 `<staging>/.mimir/workspace.writer-lock`
 *   带到 `<targetRoot>/.mimir/`，发布后写目标目录时确已持其写锁。
 *
 * ⚠️ 代价（必须记住）：这条路线**要求取锁器写完即关文件句柄**。Windows 下
 * `renameSync` 一个内含**打开句柄**的目录会 `EPERM`（实测），而
 * `acquireWriterLockFile` / `prepareNewSelection` 恰恰把 fd 一直开着。
 * 故生产必须注入 `acquireMigratableWriterLock`（`operationGate.ts`）——它写完立即
 * `closeSync`，只以文件内容作凭据，并暴露 `migrate(next)` 让锁对象跟上新路径
 * （否则 rename 后按旧路径 `release()` 会 `ENOENT`，实测）。
 *
 * 编排层**不做任何建目录动作**：只在 ② 校验目标父目录存在（暂存根与目标同盘，
 * 父目录不存在会让 `createStagingRoot` 失败）。目标目录本身由 publish 落地。
 * `targetExists` 仍保留用于**预检硬拒绝**（用户真有一个同名目录时给出清晰的
 * `TARGET_EXISTS`，而不是让它死在 publish 阶段）。
 *
 * 失败时**不自行删任何路径**：`outcome.cleanup` 已由 `abortScope` 给出「本操作产物」
 * 范围，是否回收由调用方（维护窗口）显式决定。
 *
 * @returns `RestoreOutcome`；**永不抛异常**（失败以 `stage:'failed'` 表达）
 */
export async function runMaintenanceRestore(
  request: RestoreRequest,
  deps: MaintenanceRestoreDeps
): Promise<RestoreOutcome> {
  const now = (): Date => new Date()
  const targetExists = deps.targetExists ?? existsSync
  const archiveExists = deps.archiveExists ?? existsSync
  const isExistingDirectory =
    deps.isExistingDirectory ?? ((path: string) => existsSync(path) && statSync(path).isDirectory())
  const report = (stage: string, detail: string): void => {
    try {
      deps.onProgress?.({ stage, detail })
    } catch {
      // 进度回调失败**不得**影响恢复本身。
    }
  }

  // ── ① 入参校验（零副作用） ────────────────────────────────────────
  if (request.archivePath.trim() === '') {
    return failedEarly('INVALID_TARGET', '未提供归档路径。', now())
  }
  if (!archiveExists(request.archivePath)) {
    return failedEarly('INVALID_TARGET', `归档不存在：${request.archivePath}`, now())
  }
  if (request.targetRoot.trim() === '') {
    return failedEarly('INVALID_TARGET', '未提供目标空间路径。', now())
  }
  if (request.spaceName.trim() === '') {
    return failedEarly('INVALID_TARGET', '新空间名不能为空。', now())
  }
  if (deps.homeDir.trim() === '') {
    // 没有 home 就没有注册表落点；提前拒绝，避免走到 registering 才失败（那时暂存已发布）。
    return failedEarly('INVALID_TARGET', '未提供注册表 home 目录。', now())
  }
  // 落点不可覆盖是**硬拒绝**（§2.3）：提前给出同一错误码，避免白解压一遍才发现目标被占。
  // 注：此处**不**做任何建目录动作（编排层从不建目标目录，见函数头注释），
  // 故不存在「把自建空目录误判成用户目录」的风险。
  if (targetExists(request.targetRoot)) {
    return failedEarly('TARGET_EXISTS', `目标目录已存在，拒绝覆盖：${request.targetRoot}`, now())
  }

  // ── ② 校验目标父目录存在（**不建任何目录**） ──────────────────────
  // 暂存根是目标的**兄弟**目录（`<targetParent>/.mimir-restore-staging-<token>`），
  // 与目标同盘。父目录不存在，`createStagingRoot` 的 mkdir 与随后的 rename 都会失败；
  // 这里提前给出清晰错误。**刻意不 `recursive: true` 自动补父级**：目标父目录由用户
  // 在渲染层选定，静默创建多级父目录会把「用户选错路径」变成「默默在错的地方建出一棵树」。
  const targetParent = dirname(request.targetRoot)
  if (!isExistingDirectory(targetParent)) {
    return failedEarly(
      'INVALID_TARGET',
      `目标空间的父目录不存在或不是目录：${targetParent}`,
      now()
    )
  }
  // 父目录**不得为符号链接/junction**（与 S8 同口径）。
  // ⚠️ 上一步的 `isExistingDirectory` 默认实现用 `statSync`（**跟随链接**），
  // 符号链接父目录会被判为「存在的目录」而放行；若不在此处拦截，会一路走到
  // publish/rename 才以无信息量的 `INTERNAL` 失败（用户拿不到「父目录是链接」的原因）。
  // 用 `lstatSync` 看链接自身，命中即拒绝。检测函数可注入以便测试替身。
  const isSymlink = deps.isSymbolicLinkPath ?? ((path: string) => {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      // 上一步已确认存在；此处若仍不可 stat，交由后续步骤以既有语义报错，不在此改变错误码。
      return false
    }
  })
  if (isSymlink(targetParent)) {
    return failedEarly(
      'INVALID_TARGET',
      `目标空间的父目录是符号链接/junction，拒绝在其下恢复：${targetParent}`,
      now()
    )
  }
  // 会话健康检查：维护窗口若已失效，任何写操作都该被拒（§4.2 S5 的 registry 锁由会话持有）。
  try {
    deps.session.assertUsable()
  } catch (error) {
    return failedEarly('LOCK_UNAVAILABLE', `维护会话不可用：${(error as Error).message}`, now())
  }

  // ── ③ 确定 T03 的匹配基准（旧空间**绝对**根） ────────────────────────
  // ⚠️ 必须用清单里的 `sourceRoot`（绝对路径），**不能**用 `oldRootFromArchive` 的相对根：
  // `remapRules.matchRootPrefix` 要求「旧根与待改写值都为绝对路径」，而 store 里的 `pdfPath`
  // 是绝对路径 → 相对根永不命中（实测 `rewritten=0`，理由 `outside-old-root`）。
  // 相对根只用来在清单无 `sourceRoot` 时给一条**非权威**诊断文案。
  let oldRoot = ''
  let sourceSpaceId: string | undefined
  try {
    const manifest = await (deps.readManifest ?? readArchiveManifest)(request.archivePath)
    sourceSpaceId = manifest.sourceSpaceId
    const sourceRoot = typeof manifest.sourceRoot === 'string' ? manifest.sourceRoot.trim() : ''
    const relativeRoot = oldRootFromArchive(manifest.entries)
    if (sourceRoot !== '') {
      oldRoot = sourceRoot
      // ⚠️ 脱敏纪律（I6 批次 4 §0.3）：**绝不**把 `oldRoot`（本机绝对路径）塞进进度文案。
      // `MaintenanceRestoreProgress.detail`（`workspaceBackupContracts.ts`）明写「不含任何本机
      // 路径」，此前版本 `report('inspecting', \`归档内旧空间根：${oldRoot}\`)` 直接违反该契约。
      // 现只报「已取到旧根」这一事实，位置信息由主进程内部使用，不外泄到渲染层。
      report('inspecting', '已从归档清单取到旧空间根。')
    } else {
      // 早期归档（批次 2/3 之前产出）没有 sourceRoot：退化为「不改写」，**绝不猜测**。
      // 猜错会把用户空间外的 PDF 路径改到新空间里（§7 K2 高危误写）。
      const hint = relativeRoot === null ? '（条目形态无法推出顶层目录）' : `（归档顶层目录约为 ${relativeRoot}）`
      report(
        'inspecting',
        `归档未记录源空间绝对根，恢复后不自动改写论文路径${hint}；空间仍会完整恢复。`
      )
    }
  } catch (error) {
    // 清单读不出**不阻断**：`verifyBackup` 才是真正的守门人，它会给出确切拒绝理由。
    // 此处退化为「不改写」，空间仍可完整恢复（§3.4：未命中不失败）。
    report('inspecting', `无法读取归档清单，恢复后不自动改写论文路径：${(error as Error).message}`)
  }

  // ── ④ 编排（真适配器 + 真完整性钩子 + 暂存根内写锁） ─────────────
  let operation: ReturnType<NonNullable<MaintenanceRestoreDeps['beginOperation']>> | undefined
  try { operation = deps.beginOperation?.() }
  catch { return failedEarly('LOCK_UNAVAILABLE', '无法保存恢复操作记录，未创建恢复资料。', now()) }
  const input: RestoreInput = {
    archivePath: request.archivePath,
    targetRoot: request.targetRoot,
    stagingRoot: stagingPathFor(request.targetRoot, operation?.id ?? 'restore'),
    // 真实 home：注册步骤会在此**真正**追加新空间（见文件头注释）。
    homeDir: deps.homeDir,
    spaceName: request.spaceName,
    oldRoot,
    sourceSpaceId
  }

  // `targetExistedBefore` 恒为 `false`：本编排层从不建目标目录（见函数头注释），
  // 走到这里时目标必然不存在（步骤 ① 已硬拒存在的情况）。仍显式传入而不依赖
  // 适配器的实时 stat 兜底，意在把「编排层保证目标不存在」这条不变量写成代码而非巧合。
  //
  // `lockStagingRoot` 由调用方注入（生产 = `acquireMigratableWriterLock` 包装），
  // 适配器会在 `createStaging` 内、**解压之前**用它取锁（§4.2 S5 锁先行）。
  const baseSteps = createMaintenanceRestoreSteps(false, deps.lockStagingRoot, { ...deps.adapter, ...(operation ? { stagingToken: operation.id } : {}) }, deps.assetsIntegrityOptions)
  const steps = operation ? operation.decorate(baseSteps, input) : baseSteps

  report('extracting', '开始解压到同盘暂存根…')
  const outcome = await runRestore(input, steps, { now, ...(operation ? { newId: () => operation.spaceId } : {}) })
  report(
    outcome.stage,
    outcome.failure === null ? '恢复完成。' : `恢复失败：${outcome.failure.code}`
  )
  return outcome
}

/** 早退失败（此时**尚未产生**任何本操作产物，故 `cleanup` 为 `null`）。 */
function failedEarly(
  code: 'INVALID_TARGET' | 'TARGET_EXISTS' | 'LOCK_UNAVAILABLE',
  detail: string,
  at: Date
): RestoreOutcome {
  return {
    stage: 'failed',
    failure: { stage: 'inspecting', code, retryable: false, detail },
    result: null,
    remap: null,
    cleanup: null,
    finishedAt: at.toISOString()
  }
}

export { RestoreError }
