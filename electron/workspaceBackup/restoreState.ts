/**
 * 新空间恢复状态机（I6 批次 3 · 第 1 块，纯函数）。
 *
 * 职责：把设计 §1.1 的状态转移表与 §1.3 的失败语义实现为**无副作用**的纯函数，
 * 供 `restoreRunner`（T04）驱动、供单测穷举。
 *
 * 纪律：
 * - **零 IO**：不读盘、不写盘、不 import 任何 fs/electron。T01 因此可被完全单测。
 * - 阶段字符串与 `restoreContracts.RestoreStage` 一致；非法转移一律抛 `RestoreError`。
 * - `abortScope` **绝不返回原空间/原注册表路径**（设计 §1.3 规则 2）。
 */

import {
  RestoreError,
  type CleanupScope,
  type RestoreEvent,
  type RestoreFailure,
  type RestoreStage
} from './restoreContracts'

/** 允许的状态转移表：`<from>` → 允许的 `<event>` → `<to>`。 */
const TRANSITIONS: Record<RestoreStage, Partial<Record<RestoreEvent, RestoreStage>>> = {
  idle: { selectArchive: 'inspecting' },
  inspecting: { verifyOk: 'planned', planReady: 'planned', verifyFail: 'failed' },
  planned: { userConfirm: 'extracting', userCancel: 'idle' },
  extracting: { extractOk: 'verifying', extractFail: 'failed' },
  verifying: { recheckOk: 'publishing', recheckFail: 'failed' },
  publishing: { publishOk: 'registering', publishFail: 'failed' },
  registering: { registerOk: 'done', registerFail: 'failed' },
  done: {},
  // 终态但非破坏态：只能回到最早失败阶段的重新入口（retry）或清理退出（abort）。
  failed: { retry: 'inspecting', abort: 'failed' }
}

/** 合法事件集合覆盖检查用（供测试与文档对齐）。 */
export const RESTORE_EVENTS: readonly RestoreEvent[] = [
  'selectArchive', 'verifyOk', 'verifyFail', 'planReady', 'userConfirm', 'userCancel',
  'extractOk', 'extractFail', 'recheckOk', 'recheckFail', 'publishOk', 'publishFail',
  'registerOk', 'registerFail', 'retry', 'abort'
]

/** 终态判断：`done` 与 `failed` 都是终态（`failed` 仍可 retry/abort，但不产生前进）。 */
export function isTerminal(stage: RestoreStage): boolean {
  return stage === 'done' || stage === 'failed'
}

/**
 * 推进状态机。非法转移抛 `RestoreError('INTERNAL')`（含 from/event 便于定位）。
 *
 * @throws RestoreError 当 `event` 在当前阶段不合法
 */
export function nextStage(current: RestoreStage, event: RestoreEvent): RestoreStage {
  const next = TRANSITIONS[current]?.[event]
  if (next === undefined) {
    throw new RestoreError('INTERNAL', `非法状态转移：${current} --${event}--> 无目标`)
  }
  return next
}

/** 某失败是否可重试（对应设计 §1.3 的「可重试性」列）。 */
export function canRetry(failure: RestoreFailure): boolean {
  return failure.retryable
}

/**
 * `failed` 终态的 `abort` 应清理哪些「本操作产物」。
 *
 * **安全边界（设计 §1.3 规则 2）**：只返回 `stagingRoot`（本次暂存根）与
 * `createdTarget`（本次已发布但未注册成功的新目录，仅当确由本操作创建）。
 * **绝不**包含原空间根、原注册表文件或其它空间目录——调用方据此清理即可保证
 * 「崩溃/失败只清本操作产物」。
 */
export function abortScope(failure: RestoreFailure, paths: { stagingRoot: string; createdTarget: string | null }): CleanupScope {
  const stagingRoot = normalize(paths.stagingRoot)
  const createdTarget = paths.createdTarget === null ? null : normalize(paths.createdTarget)

  // 防御：createdTarget 不得等于或包含 stagingRoot 的父级等可疑形态。
  if (createdTarget !== null && createdTarget === stagingRoot) {
    throw new RestoreError('INTERNAL', '清理范围非法：目标目录与暂存根相同。')
  }
  // `abort` 只在 failed 态语义成立；其它阶段不应调用（调用方错误）。
  if (failure.stage !== 'failed') {
    throw new RestoreError('INTERNAL', `abortScope 只适用于 failed 阶段，收到 ${failure.stage}`)
  }
  return { stagingRoot, createdTarget }
}

/** 去掉结尾分隔符并统一为正斜杠，便于比较（不解析盘符/不做 realpath）。 */
function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}
