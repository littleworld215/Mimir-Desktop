/**
 * 插件 Hooks 的**运行时消费**（新批次 B）。
 *
 * 职责：把用户在「插件 / Hooks」页配置并启用的事件钩子（store 键 `plugins:hooks`），
 * 在工具调用的生命周期时机**分派**出去。
 *
 * ── 范围（本批**只接线，不放权**）─────────────────────────────────────────
 * 本模块**不执行** `script` / `command` / `http` 三种动作。理由：在主进程里执行用户自由文本
 * 等于开放一个任意代码执行 / 数据外泄面（`command` 无沙箱 RCE、`script` 无法安全隔离、
 * `http` 是外发通道）。真实执行器需要沙箱与批准链，**须单独裁决**，不在本批。
 *
 * 本批交付的是**钩子运行时骨架**：谁（哪些钩子）/ 何时（哪个事件）/ 顺序（store 序）/
 * 失败如何隔离（永不拖垮工具）。骨架是后续执行器的**前提**，且自身**零安全面扩张**
 * ——因为执行器是 no-op 记录器，本批不新增 IPC、不新增文件写入、不新增网络调用。
 *
 * ── 三条铁律 ──────────────────────────────────────────────────────────────
 * 1. **失败隔离**（对齐 `backupService.safeWriteAudit`）：钩子分派全程 try/catch。
 *    用户配错一行钩子**绝不能让工具调用失败**——否则「设置里加错一行」就能瘫痪整个 Agent。
 * 2. **脱敏**（对齐批次 4 审计纪律）：trace **只记**工具名/钩子名/actionType/结果码，
 *    **绝不记**工具入参值、返回值、payload 原文、路径或凭据。
 * 3. **防御式解析**（对齐 `capabilityDomains.loadCapabilityDomains`）：store 读取包 try/catch；
 *    逐项类型校验；**只取 `enabled === true`**；非法项跳过而非全盘失败。
 *
 * ── 事件名以 UI 为准 ──────────────────────────────────────────────────────
 * `Plugins.tsx:1408-1412` 的下拉选项是用户实际能写入 store 的取值：
 * `message:beforeSend` / `message:afterComplete` / `agent:beforeTool` / `agent:afterTool`。
 * （`Plugins.tsx:12` 旧 TODO 注释写的 `onBeforeTool` / `onContextReady` 是早期设计残留，
 *  **与 UI 不符**；若按注释实现将永不命中用户配置。）
 * 本批只接 `agent:*` 两个（工具生命周期）；`message:*` 属对话消息生命周期，
 * 触发点在别处，留后续批次。
 */

import { getStoreValue } from '../library/store'
import log from '../logger'

/** `plugins:hooks` store 键（与 `Plugins.tsx:122` 的 `STORE_HOOKS` 一致）。 */
export const HOOKS_STORE_KEY = 'plugins:hooks'

/**
 * 本批消费的事件（工具生命周期）。
 * 刻意**不含** `message:*`——它们属于对话消息生命周期，见文件头说明。
 */
export type HookEvent = 'agent:beforeTool' | 'agent:afterTool'

/** store 里单条钩子的形状（与 `Plugins.tsx` 的 `HookConfig` 对齐，**只读不改**）。 */
export interface HookConfig {
  id: string
  name: string
  description: string
  event: string
  actionType: 'script' | 'command' | 'http'
  payload: string
  enabled: boolean
  createdAt: string
}

/** 分派上下文（**已脱敏**：detail 只放工具名/错误类名，不放值）。 */
export interface HookDispatchContext {
  readonly toolName: string
  /** 脱敏后的短摘要（如 `tool=read_file` 或 `tool=read_file error=TypeError`）。 */
  readonly detail: string
}

/**
 * 读取已启用且事件匹配的钩子。
 *
 * 顺序 = store 数组顺序（用户在 UI 里的排列序），不额外排序。
 * store 未就绪 / 非法一律返回空数组（**永不抛**）：钩子是增强，缺它不该影响工具。
 */
export function loadHooks(event: HookEvent): HookConfig[] {
  let raw: unknown
  try {
    raw = getStoreValue<unknown>(HOOKS_STORE_KEY)
  } catch {
    // store 未就绪 / 不在操作作用域内 → 无钩子（不是错误）。
    return []
  }
  if (!Array.isArray(raw)) return []

  const result: HookConfig[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    // 仅启用项参与运行（与 UI 的开关语义一致）。
    if (rec.enabled !== true) continue
    // 事件必须精确匹配本批支持的事件名。
    if (rec.event !== event) continue
    const actionType = rec.actionType
    if (actionType !== 'script' && actionType !== 'command' && actionType !== 'http') continue
    result.push({
      id: typeof rec.id === 'string' ? rec.id : '',
      name: typeof rec.name === 'string' ? rec.name : '',
      description: typeof rec.description === 'string' ? rec.description : '',
      event: rec.event as string,
      actionType,
      payload: typeof rec.payload === 'string' ? rec.payload : '',
      enabled: true,
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : ''
    })
  }
  return result
}

/**
 * 分派一次事件。**永不抛、永不阻塞工具结果**。
 *
 * 行为：读出匹配的钩子 → 对每条记录一条 trace（此时**不执行**其 action）。
 * 返回实际触发的钩子数量（供调用方按需观测；0 是最常见情形，无需特殊处理）。
 *
 * ⚠️ 本函数是**同步**的（`withToolTrace` 的回调是同步签名）。它不做任何 await，
 * 故天然不可能阻塞工具；后续若要接真实执行器（async），须改为「投递到队列」
 * 而非在此 await——**那属于后续批次的契约变更**，本批不预留半吊子接口。
 */
export function dispatchHooks(event: HookEvent, ctx: HookDispatchContext): number {
  let hooks: HookConfig[]
  try {
    hooks = loadHooks(event)
  } catch {
    // loadHooks 自身已 try/catch，此处为双重保险（防御性）。
    return 0
  }
  if (hooks.length === 0) return 0

  let dispatched = 0
  for (const hook of hooks) {
    try {
      // ⚠️ 只记脱敏元数据：**绝不**记 payload 原文 / 工具入参值 / 返回值 / 路径。
      // `unsupported` 明确表示「本批不执行该 action」，为后续执行器留出可观测的过渡态。
      log.info(
        `[hooks] 触发 ${event} hook=${hook.name || hook.id} action=${hook.actionType} ` +
          `outcome=unsupported(未执行) ${ctx.detail}`
      )
      dispatched += 1
    } catch {
      // 单条钩子的记录失败不影响其余钩子（逐条隔离）。
      // 注意：日志设施未初始化时 log.info 可能抛错，吞掉即可——钩子是增强。
    }
  }
  return dispatched
}

/**
 * 生成脱敏摘要：只放工具名与（可选）错误**类名**。
 *
 * 刻意**不放**：参数值、返回值、路径、URL、message（message 可能含绝对路径）。
 * 想扩展内容时，**先问「这会不会把用户数据写进日志」**——对齐批次 4 脱敏口径。
 */
export function describeToolCall(toolName: string, error?: unknown): string {
  const base = `tool=${toolName}`
  if (error === undefined) return base
  const kind =
    error instanceof Error
      ? error.name // 只要类名（TypeError / AbortError…），不要 message
      : typeof error
  return `${base} error=${kind}`
}
