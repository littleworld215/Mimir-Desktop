/**
 * 新空间恢复编排（I6 批次 3 · 第 4 块 · restoreRunner）。
 *
 * 职责：把 T01（契约 / 状态机 / 计划）、T02（暂存根 / 解压 / 复校）、T03（关联路径审计改写）
 * 与 T04 的发布 / 注册**串成一次恢复**，并**逐条落实**设计
 * `docs/design/I6-BATCH3-RESTORE.md` §1.3 的失败语义表。
 *
 * 纪律（与 §1.3「核心纪律」一一对应）：
 *
 * 1. **完全依赖注入**：本文件**不 import** `publish.ts` / `registryAppend.ts`（T04 并行产物），
 *    也不 import 任何 `electron` / `fs`。所有**有副作用**的动作都是 `RestoreSteps` 注入的函数，
 *    每个函数都是一个**唯一副作用边界**。收益有二：
 *    - 本模块不依赖尚未落地的文件即可 typecheck；
 *    - 单测能用假实现精确断言「哪一步被调用、哪一步没被调用」——
 *      这是验证 §1.3 失败语义的**唯一可靠手段**（副作用断言）。
 * 2. **失败绝不授予半成品空间**：任何阶段失败，注册步骤（`register`）都不会被调用到能写入的程度；
 *    已发布但未注册时，`cleanup.createdTarget` 供上层 `abort` 精确回收（§1.3 规则 1 / 规则 2）。
 * 3. **纪律 3（`ok:false` 一律阻断）**：任何步骤若返回 `{ ok: false }` 形状的结果，
 *    **按失败处理**，绝不当成功继续（对齐 D-071 与 context-control Ruling）。
 *    本文件的注入契约是「抛错即失败」，返回值契约只用于 `{ appended }` 这类幂等回执
 *    ——`appended:false` 表示「重试命中已注册」，**不是**失败（§4.2 S9）。
 * 4. **纪律 4（控制不可嵌套）**：本文件**绝不**调用 `workspaces:*` 等会被
 *    `installWorkspaceIpcGate` 包进 `runControl` 的 IPC 通道——那会让恢复自我等待排空而死锁。
 *    发布 / 注册一律走**注入的直接函数**（由调用方在持锁下直连 store），**不经 IPC**；
 *    本文件因此零 `ipcRenderer` / 零 `gate` 依赖。
 * 5. **清理只限本操作产物**：`cleanup` 一律经 `restoreState.abortScope` 推导（它自带
 *    「目标目录与暂存根相同 → 抛 INTERNAL」的安全断言），**绝不**自行拼接路径，
 *    **绝不**把原空间根 / 原注册表 / 其它空间纳入清理范围。
 * 6. **绝不向上抛未捕获异常**：`runRestore` 总是返回 `RestoreOutcome`；失败时 `stage='failed'`。
 *    非 `RestoreError` 的异常统一归为 `INTERNAL`。
 */

import { randomUUID } from 'node:crypto'

import {
  RestoreError,
  type CleanupScope,
  type RestoreErrorCode,
  type RestoreEvent,
  type RestoreFailure,
  type RestorePlan,
  type RestoreResult,
  type RestoreStage
} from './restoreContracts'
import { abortScope, nextStage } from './restoreState'
import type { RemapAuditReport } from './remapAudit'

/** 一次恢复的输入：全部由主进程规范化后给出（渲染层不拼路径，§4.2 S7）。 */
export interface RestoreInput {
  /** 归档文件绝对路径。 */
  readonly archivePath: string
  /** 目标新空间根：必须不存在（§2.1 拒绝覆盖）。 */
  readonly targetRoot: string
  /** 与 `targetRoot` 同父目录的暂存根（计划值；实际以 `createStaging` 返回为准）。 */
  readonly stagingRoot: string
  /** 合成 home：注册表写入落点。**绝不**使用真实 `homedir()`（§4.3）。 */
  readonly homeDir: string
  /** 新空间名（用于注册记录）。 */
  readonly spaceName: string
  /** 归档内记录的旧空间根：供 T03 重映射匹配旧前缀。 */
  readonly oldRoot: string
}

/** 注册步骤的回执：`appended:false` = 命中幂等（已注册过），**不是**失败。 */
export interface RegisterReceipt {
  /** 本次是否真的追加了一条新记录。 */
  readonly appended: boolean
}

/**
 * 注入的步骤集合：**每个键都是一个唯一副作用边界**。
 *
 * 约定：
 * - 失败 = **抛错**（优先抛 `RestoreError` 带语义码；其它异常由 runner 归一为 `INTERNAL`）；
 * - 若某实现改用返回值契约，则 `{ ok: false }` 一律按失败处理（纪律 3）。
 */
export interface RestoreSteps {
  /** 只读验包 + 生成计划（§1.1 `inspecting`；**零副作用**）。 */
  readonly inspect: (input: RestoreInput) => Promise<RestorePlan>
  /** 创建本次暂存根（独占），返回**实际**路径。 */
  readonly createStaging: (input: RestoreInput) => Promise<string>
  /** 解压到暂存根，返回落地条目数。 */
  readonly extract: (input: RestoreInput, stagingRoot: string) => Promise<number>
  /** T03 关联路径审计 + 改写回写暂存副本（在 `verifying` 阶段内，§3.4）。 */
  readonly remap: (input: RestoreInput, stagingRoot: string) => Promise<RemapAuditReport>
  /** 二次校验：JSON / 数据库 / 外键 / 摘要（§3.4 步骤 c）。 */
  readonly recheck: (input: RestoreInput, stagingRoot: string) => Promise<void>
  /** 同盘 `rename` 发布暂存根 → 目标新目录（rename 前双检 `TARGET_EXISTS`）。 */
  readonly publish: (input: RestoreInput, stagingRoot: string) => Promise<void>
  /**
   * 可选探针：**本次操作**是否已把目标目录造出来。仅在 `publishing` 失败时调用一次。
   *
   * 存在理由：病态的 `PUBLISH_FAILED`（rename 返回成功、但发布后复核失败）下目标**可能已存在**，
   * 此时 `cleanup.createdTarget` 必须是它，否则 abort 会漏掉一件本操作产物。
   *
   * ⚠️ **绝不能**用 `existsSync(targetRoot)` 代替本探针：`TARGET_EXISTS` 场景下目标是
   * **用户既有的目录**，本操作从未创建它——按「存在」判定会让 abort 删掉用户目录
   * （违反 §1.3 规则 2「仅当它确由本操作创建」）。真值只有 `publish` 的实现知道。
   */
  readonly targetCreated?: (input: RestoreInput) => Promise<boolean>
  /** 注册表原始快照 + 原子追加新 UUID 记录（S1–S10）；**不经 IPC**。 */
  readonly register: (input: RestoreInput, spaceId: string) => Promise<RegisterReceipt>
  /** 清理**本操作**暂存根（只清本次产物）。 */
  readonly cleanupStaging: (stagingRoot: string) => Promise<void>
}

/** 一次恢复的结果：成功给 `result`，失败给 `failure` + `cleanup`。 */
export interface RestoreOutcome {
  /** 终态：`done` 或 `failed`。 */
  readonly stage: RestoreStage
  readonly failure: RestoreFailure | null
  readonly result: RestoreResult | null
  /** T03 审计报告（即使后续阶段失败也如实带回，便于排查）。 */
  readonly remap: RemapAuditReport | null
  /** `failed` 时的本操作清理范围；成功或「无产物」时为 `null`。 */
  readonly cleanup: CleanupScope | null
  /** 收尾时刻（ISO），由 `opts.now` 注入以便测试确定性。 */
  readonly finishedAt: string
}

/** 状态机推进器（默认 T01 的 `nextStage`；可注入以构造非法转移）。 */
export type RestoreAdvance = (stage: RestoreStage, event: RestoreEvent) => RestoreStage

export interface RestoreRunnerOptions {
  /** 新空间 id 生成器（默认 `randomUUID()`）。 */
  readonly newId?: () => string
  /** 时钟（默认 `new Date()`）；用于 `finishedAt` 可确定性断言。 */
  readonly now?: () => Date
  /** 状态机推进器（默认 `nextStage`）；注入可验证「非法转移 → INTERNAL」。 */
  readonly advance?: RestoreAdvance
}

/** 每个工作阶段对应的失败事件（§1.2 状态图）。 */
export const RESTORE_FAIL_EVENT: Partial<Record<RestoreStage, RestoreEvent>> = {
  inspecting: 'verifyFail',
  extracting: 'extractFail',
  verifying: 'recheckFail',
  publishing: 'publishFail',
  registering: 'registerFail'
}

/** 是否为「对象」形态（用于 `{ ok:false }` 与错误对象探测）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 取错误文案（兼容非 `Error` 的抛出物）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * 归一为 `RestoreError`。
 *
 * 采用「`instanceof` + 名称/码鸭子判定」双通道：当 `restoreContracts` 被不同模块图
 * 各加载一份时（如测试用绝对路径动态 import），`instanceof` 会失效，
 * 鸭子判定保证错误码**不丢**——否则语义码会被静默降级成 `INTERNAL`。
 */
function asRestoreError(error: unknown): RestoreError | null {
  if (error instanceof RestoreError) return error
  if (!isRecord(error)) return null
  if (error.name !== 'RestoreError') return null
  if (typeof error.code !== 'string') return null
  return new RestoreError(error.code as RestoreErrorCode, describeError(error))
}

/** 由任意抛出物构造 `RestoreFailure`（非 `RestoreError` 归一为 `INTERNAL`）。 */
function toFailure(error: unknown, stage: RestoreStage, retryable: boolean): RestoreFailure {
  const restored = asRestoreError(error)
  if (restored !== null) {
    return { stage, code: restored.code, retryable, detail: restored.message }
  }
  return { stage, code: 'INTERNAL', retryable, detail: describeError(error) }
}

/**
 * 纪律 3：任何 `ok:false` 形状的返回值一律按失败处理。
 *
 * 只认**显式的** `ok === false`；`{ appended: false }` 这类幂等回执**不**在此列
 * （§4.2 S9：重试命中已注册是正常终局，不得当失败、也不得再造第二条记录）。
 *
 * @throws RestoreError 当 `value.ok === false`
 */
function rejectFailedResult(value: unknown, stage: RestoreStage, label: string): void {
  if (!isRecord(value)) return
  if (value.ok !== false) return
  const code = typeof value.code === 'string' ? (value.code as RestoreErrorCode) : 'INTERNAL'
  const reason =
    typeof value.message === 'string'
      ? value.message
      : typeof value.detail === 'string'
        ? value.detail
        : '未提供原因'
  throw new RestoreError(code, `${label} 返回 ok:false（纪律 3：一律按失败处理，不得继续）：${reason}（阶段 ${stage}）`)
}

/** 路径归一：统一分隔符、去尾部斜杠（仅用于比较，不做 realpath）。 */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 默认 id 生成器：新空间永远是**新 UUID**（§2.3 绝不原地覆盖）。 */
function defaultNewId(): string {
  return randomUUID()
}

/**
 * 把一次恢复按 §1.1 状态序列跑完，并逐条落实 §1.3 的失败语义。
 *
 * 副作用语义（**验收核心**，见 `restoreRunner.test.ts` 的逐条断言）：
 *
 * | 失败阶段 | `cleanupStaging` | `register` | `cleanup` | `retryable` |
 * |---|---|---|---|---|
 * | `inspecting` | **未调用**（零副作用） | 未调用 | `null` | `false`（需换归档） |
 * | `extracting` | **调用**（清本操作暂存） | 未调用 | 本操作暂存范围 | `true` |
 * | `verifying` | **未调用**（保留暂存供排查） | 未调用 | 本操作暂存范围 | `true` |
 * | `publishing` | **未调用**（保留暂存） | 未调用 | 暂存范围；`createdTarget` 由 `targetCreated` 探针给出（默认 `null`） | `true` |
 * | `registering` | 未调用（暂存已消费） | 调用过 | 暂存 + 已发布目标 | `true`（只重做注册） |
 *
 * @returns `RestoreOutcome`；**永不抛异常**
 */
export async function runRestore(
  input: RestoreInput,
  steps: RestoreSteps,
  opts: RestoreRunnerOptions = {}
): Promise<RestoreOutcome> {
  const newId = opts.newId ?? defaultNewId
  const now = opts.now ?? ((): Date => new Date())
  const advance = opts.advance ?? nextStage

  /** 状态机当前阶段。 */
  let stage: RestoreStage = 'idle'
  /** 最近一个「工作阶段」（用于兜底失败归属，不含 `idle`/`done`/`failed`）。 */
  let phase: RestoreStage = 'inspecting'
  /** 本操作实际持有的暂存根；未取得（含 `createStaging` 失败）时为 `null`。 */
  let stagingRoot: string | null = null
  /** 目标是否已被 `publish` 落盘（决定 `cleanup.createdTarget`）。 */
  let published = false
  /** 验包/计划产物（`inspect` 成功后非空）。 */
  let plan: RestorePlan | null = null
  /** T03 审计报告。 */
  let remapReport: RemapAuditReport | null = null

  /**
   * 推进一步并**校验落点**：非法转移（`advance` 抛错）或落点与预期不符
   * （注入的推进器给出了别的阶段）→ `INTERNAL`，**绝不静默继续**。
   */
  const advanceTo = (event: RestoreEvent, expected: RestoreStage): void => {
    const actual = advance(stage, event)
    if (actual !== expected) {
      throw new RestoreError(
        'INTERNAL',
        `状态机推进异常：${stage} --${event}--> ${actual}（期望 ${expected}）`
      )
    }
    stage = actual
    if (actual !== 'failed') phase = actual
  }

  /**
   * 推导「本操作产物」清理范围：一律经 `abortScope`，绝不自行拼路径。
   * 暂存根尚未取得时返回 `null`（此时没有任何本操作产物可清）。
   */
  const buildCleanup = (createdTarget: string | null): { scope: CleanupScope | null; note: string | null } => {
    if (stagingRoot === null) return { scope: null, note: null }
    try {
      const scope = abortScope(
        { stage: 'failed', code: 'INTERNAL', retryable: true, detail: '推导本操作清理范围' },
        { stagingRoot, createdTarget }
      )
      return { scope, note: null }
    } catch (error) {
      // 清理范围推导失败 = 内部不变量被破坏（如目标与暂存根同路径）：必须显式暴露。
      return { scope: null, note: `清理范围推导失败：${describeError(error)}` }
    }
  }

  /** 构造失败终局；内部全程 try/catch，**保证自身不抛**。 */
  const failAt = (
    failedStage: RestoreStage,
    error: unknown,
    retryable: boolean,
    createdTarget: string | null,
    extraNotes: readonly string[] = []
  ): RestoreOutcome => {
    const base = toFailure(error, failedStage, retryable)
    const failEvent = RESTORE_FAIL_EVENT[failedStage]
    const notes: string[] = [...extraNotes]
    let machineNote: string | null = null
    // 仅当机器**正处于**失败发生的那个阶段时才补发失败事件：这样失败事件必然合法。
    // 若机器尚未进入该阶段（例如入参校验发生在进入 `inspecting` 之前），
    // 则不存在可补发的合法事件，此时不惩罚、也不伪造转移。
    if (failEvent !== undefined && RESTORE_FAIL_EVENT[stage] === failEvent) {
      try {
        advanceTo(failEvent, 'failed')
      } catch (advanceError) {
        machineNote = `状态机推进失败：${describeError(advanceError)}`
        notes.push(machineNote)
      }
    }
    const { scope, note: scopeNote } = buildCleanup(createdTarget)
    if (scopeNote !== null) notes.push(scopeNote)

    const detail = notes.length === 0 ? base.detail : `${base.detail}（${notes.join('；')}）`
    // 清理范围/状态机任一内部不变量被破坏 → 以 INTERNAL 暴露，不用原错误码掩盖。
    const code: RestoreErrorCode = machineNote !== null || scopeNote !== null ? 'INTERNAL' : base.code
    return {
      stage: 'failed',
      failure: { stage: failedStage, code, retryable, detail },
      result: null,
      remap: remapReport,
      cleanup: scope,
      finishedAt: now().toISOString()
    }
  }

  /**
   * `publishing` 失败出口：保留暂存根，并按**本操作是否真的造出了目标**决定 `createdTarget`。
   *
   * 未注入 `targetCreated` 探针时保守取 `null`（宁可漏清一件产物，也绝不误删用户目录）。
   */
  const failPublishing = async (error: unknown): Promise<RestoreOutcome> => {
    const notes: string[] = []
    let createdTarget: string | null = null
    if (steps.targetCreated !== undefined) {
      try {
        createdTarget = (await steps.targetCreated(input)) ? input.targetRoot : null
      } catch (probeError) {
        notes.push(`目标创建状态探测失败（保守按「未创建」处理）：${describeError(probeError)}`)
        createdTarget = null
      }
    }
    return failAt('publishing', error, true, createdTarget, notes)
  }

  /** `extracting` 失败出口：先清理本操作暂存（§1.3 第 2 行），再落 `failed`。 */
  const failExtracting = async (error: unknown): Promise<RestoreOutcome> => {
    if (stagingRoot === null) {
      // 尚未取得本操作暂存根（如 `createStaging` 失败）：绝不清理不属于本次的路径。
      return failAt('extracting', error, true, null)
    }
    const note = await cleanupBestEffort(steps, stagingRoot)
    return failAt('extracting', error, true, null, note === null ? [] : [note])
  }

  try {
    // ── ① inspecting：只读验包 + 计划（§1.3：零副作用） ─────────────────
    try {
      advanceTo('selectArchive', 'inspecting')
    } catch (error) {
      return failAt('inspecting', error, false, null)
    }

    // 入参自洽性（纯字符串校验，零副作用）：目标与暂存根绝不能是同一路径
    // ——否则 `abortScope` 会在清理期抛 INTERNAL，这里提前以 `INVALID_TARGET` 拒绝。
    // 属调用方参数错误，须换参数重试 → `retryable=false`。
    try {
      if (input.targetRoot.trim() === '' || input.stagingRoot.trim() === '') {
        throw new RestoreError('INVALID_TARGET', '目标空间路径与暂存根路径均不能为空。')
      }
      if (normalizePath(input.targetRoot) === normalizePath(input.stagingRoot)) {
        throw new RestoreError('INVALID_TARGET', `目标空间路径不得与暂存根相同：${input.targetRoot}`)
      }
    } catch (error) {
      return failAt('inspecting', error, false, null)
    }

    try {
      const inspected = await steps.inspect(input)
      rejectFailedResult(inspected, 'inspecting', 'inspect')
      if (!isRecord(inspected)) {
        throw new RestoreError('INTERNAL', 'inspect 未返回恢复计划（RestorePlan）。')
      }
      // 计划必须与已确认落点一致：防止注入实现给出另一份目标（D-071「不得静默改名」）。
      if (typeof inspected.targetRoot === 'string' && normalizePath(inspected.targetRoot) !== normalizePath(input.targetRoot)) {
        throw new RestoreError('INTERNAL', `恢复计划的目标与落点不一致：${inspected.targetRoot} ≠ ${input.targetRoot}`)
      }
      plan = inspected as RestorePlan
    } catch (error) {
      // `inspecting` 失败：需换归档，非本操作内重试 → retryable=false，且零副作用。
      return failAt('inspecting', error, false, null)
    }

    try {
      advanceTo('planReady', 'planned')
    } catch (error) {
      return failAt('inspecting', error, false, null)
    }

    // ── ② planned → extracting（落点已由用户确认） ──────────────────────
    try {
      advanceTo('userConfirm', 'extracting')
    } catch (error) {
      return failAt('extracting', error, true, null)
    }

    try {
      const created = await steps.createStaging(input)
      rejectFailedResult(created, 'extracting', 'createStaging')
      const actual = typeof created === 'string' && created.trim() !== '' ? created : input.stagingRoot
      if (actual.trim() === '') {
        throw new RestoreError('STAGING_CONFLICT', '暂存根路径为空，无法继续。')
      }
      stagingRoot = actual
    } catch (error) {
      // 未取得本操作暂存根（owned=false）：没有任何本操作产物，故不调用 cleanupStaging。
      stagingRoot = null
      return failAt('extracting', error, true, null)
    }

    try {
      const entries = await steps.extract(input, stagingRoot)
      rejectFailedResult(entries, 'extracting', 'extract')
      if (typeof entries !== 'number' || !Number.isFinite(entries) || entries < 0) {
        throw new RestoreError('EXTRACT_FAILED', 'extract 未返回有效条目数。')
      }
    } catch (error) {
      return await failExtracting(error)
    }

    try {
      advanceTo('extractOk', 'verifying')
    } catch (error) {
      return await failExtracting(error)
    }

    // ── ③ verifying：T03 改写（§3.4 a/b）+ 二次校验（§3.4 c） ────────────
    // 失败一律**保留暂存根**供排查 → 绝不调用 cleanupStaging。
    try {
      const report = await steps.remap(input, stagingRoot)
      rejectFailedResult(report, 'verifying', 'remap')
      if (!isRecord(report) || !Array.isArray(report.found)) {
        throw new RestoreError('RECHECK_FAILED', 'remap 未返回有效的审计报告（RemapAuditReport）。')
      }
      remapReport = report as RemapAuditReport
    } catch (error) {
      return failAt('verifying', error, true, null)
    }

    try {
      // `recheck` 是抛错契约（返回 void），无需返回值守卫。
      await steps.recheck(input, stagingRoot)
    } catch (error) {
      return failAt('verifying', error, true, null)
    }

    try {
      advanceTo('recheckOk', 'publishing')
    } catch (error) {
      return failAt('verifying', error, true, null)
    }

    // ── ④ publishing：同盘 rename（rename 前不建目标） ───────────────────
    // 失败保留暂存根 → 绝不调用 cleanupStaging、绝不调用 register；
    // `createdTarget` 由 `targetCreated` 探针给出（默认 null，见 `failPublishing` 注释）。
    try {
      await steps.publish(input, stagingRoot)
      published = true
    } catch (error) {
      return await failPublishing(error)
    }

    try {
      advanceTo('publishOk', 'registering')
    } catch (error) {
      return failAt('publishing', error, true, null)
    }

    // ── ⑤ registering：本机保护快照 + 原子追加（S1–S10，不经 IPC） ────────
    // 失败时目录**已发布且完整**，只有注册未完成 → retry 只重做注册。
    const spaceId = newId()
    try {
      const receipt = await steps.register(input, spaceId)
      rejectFailedResult(receipt, 'registering', 'register')
      if (!isRecord(receipt)) {
        throw new RestoreError('REGISTER_FAILED', 'register 未返回注册回执。')
      }
      // `appended:false` = 命中幂等（重试时已注册过）：不算失败，也不产生第二条记录（S9）。
    } catch (error) {
      return failAt('registering', error, true, input.targetRoot)
    }

    try {
      advanceTo('registerOk', 'done')
    } catch (error) {
      return failAt('registering', error, true, input.targetRoot)
    }

    // ── ⑥ done ─────────────────────────────────────────────────────────
    if (plan === null) {
      // 不可达（plan 在 inspecting 已赋值），保留为内部不变量的显式出口。
      return failAt('registering', new RestoreError('INTERNAL', '恢复计划丢失。'), true, input.targetRoot)
    }
    return {
      stage,
      failure: null,
      result: {
        spaceId,
        name: input.spaceName,
        root: input.targetRoot,
        entries: plan.entries,
        totalBytes: plan.totalBytes
      },
      remap: remapReport,
      cleanup: null,
      finishedAt: now().toISOString()
    }
  } catch (error) {
    // 兜底：任何未预期的逃逸都必须归一为 `failed` 终态，**绝不**抛给调用方。
    // 此处**不**主动清理暂存：内部异常保留现场供排查，由上层依据 `cleanup` 走显式 abort。
    return failAt(phase, error, true, published ? input.targetRoot : null)
  }
}

/**
 * 尽最大努力清理本操作暂存；清理失败**不**改变主失败的语义，只追加说明。
 *
 * @returns 清理失败的说明文案（成功则为 `null`）
 */
async function cleanupBestEffort(steps: RestoreSteps, stagingRoot: string): Promise<string | null> {
  try {
    await steps.cleanupStaging(stagingRoot)
    return null
  } catch (error) {
    return `暂存清理失败（暂存根可能仍在 ${stagingRoot}）：${describeError(error)}`
  }
}
