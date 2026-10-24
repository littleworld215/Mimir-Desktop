/** G-04结构路径审计：已核对节点分为found/rewritten/skipped，未知路径仅observed。对象身份授权避免用伪造定位字符串扩大改写面，不改变正文、命令或未知结构。 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RestoreError } from './restoreContracts'
import type { MaintenanceRestoreAssociations } from '../../shared/workspaceBackupContracts'
import { collectPathReferences } from './structuredPaths'
import {
  REMAP_WHITELIST,
  isAbsolutePathLike,
  replaceRootPrefix,
  type RemapMatchOptions
} from './remapRules'

/** 审计/改写共用的可选项（与 `RemapMatchOptions` 同义，便于调用方按语义引用）。 */
export type RemapOptions = RemapMatchOptions

/** 命中旧根的一条「发现」。 */
export interface RemapFinding {
  /** 空间层 store 顶层键（如 `library:papers`）。 */
  readonly storeKey: string
  /** 该键下的定位符：`library:papers` 是 arxivId；数组形态下为 `[index]`。 */
  readonly locator: string
  /** 字段名。 */
  readonly field: string
  readonly oldValue: string
  readonly newValue: string
}

/** 白名单字段**未**改写的原因。 */
export type RemapSkipReason =
  /** 值不是绝对路径（相对路径或 URL）。 */
  | 'not-absolute'
  /** 是绝对路径但不落在旧空间根之下（例如用户手工指向空间外的 PDF）。 */
  | 'outside-old-root'
  /** 空值。 */
  | 'empty'

/** 白名单字段但原样保留的一条记录（**不失败**，只上报）。 */
export interface RemapSkip {
  readonly storeKey: string
  readonly locator: string
  readonly field: string
  readonly value: string
  readonly reason: RemapSkipReason
}

/** 未知结构中的绝对路径只报告，不据此改写。 */
export interface RemapObservation {
  readonly storeKey: string
  readonly locator: string
  readonly field: string
  readonly value: string
}

/** 四桶审计报告。 */
export interface RemapAuditReport {
  /** 仅安全计数，不携带旧路径、未知名称或模板正文。 */
  readonly associations?: AssociationSummary
  /** 白名单字段且命中旧根 → 需改写。 */
  readonly found: RemapFinding[]
  /** 同上，`newValue` 已填（旧值 → 新值）。 */
  readonly rewritten: RemapFinding[]
  /** 白名单字段但未命中 → 原样保留（不失败）。 */
  readonly skipped: RemapSkip[]
  /** 非白名单字段里的绝对路径样字符串 → 只报告。 */
  readonly observed: RemapObservation[]
}

export type AssociationSummary = MaintenanceRestoreAssociations

/** 判断某「顶层键 + 字段名」是否在改写白名单内。 */
export function isWhitelistedField(storeKey: string, field: string): boolean {
  return REMAP_WHITELIST.some((rule) => rule.storeKey === storeKey && rule.field === field)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isPlainObject(value)
}

interface AuditContext {
  readonly known: WeakMap<object, Set<string>>
  readonly oldRoot: string
  readonly newRoot: string
  readonly opts: RemapOptions
  readonly found: RemapFinding[]
  readonly rewritten: RemapFinding[]
  readonly skipped: RemapSkip[]
  readonly observed: RemapObservation[]
}

/** 分流一个字符串：白名单字段 → found/skipped；非白名单 → 仅在绝对路径样时进 observed。 */
function classifyString(
  storeKey: string,
  locator: string,
  field: string,
  value: string,
  ctx: AuditContext,
  parent: object
): void {
  if (ctx.known.get(parent)?.has(field)) {
    if (value.trim() === '') {
      ctx.skipped.push({ storeKey, locator, field, value, reason: 'empty' })
      return
    }
    if (!isAbsolutePathLike(value)) {
      ctx.skipped.push({ storeKey, locator, field, value, reason: 'not-absolute' })
      return
    }
    const newValue = replaceRootPrefix(value, ctx.oldRoot, ctx.newRoot, ctx.opts)
    if (newValue === null) {
      // 绝对路径但在旧空间之外（用户手工指定的 PDF）：原样保留，计入 skipped，不失败。
      ctx.skipped.push({ storeKey, locator, field, value, reason: 'outside-old-root' })
      return
    }
    ctx.found.push({ storeKey, locator, field, oldValue: value, newValue })
    ctx.rewritten.push({ storeKey, locator, field, oldValue: value, newValue })
    return
  }
  // 非白名单：只收集「绝对路径样」的字符串，避免把普通正文灌进报告造成噪音。
  if (isAbsolutePathLike(value)) {
    ctx.observed.push({ storeKey, locator, field, value })
  }
}

/** 更深层级按对象身份分类，未知结构只观察。 */
function walkNested(node: Record<string, unknown> | unknown[], storeKey: string, locator: string, ctx: AuditContext): void {
  const isArray = Array.isArray(node)
  const entries: ReadonlyArray<readonly [string, unknown]> = isArray
    ? (node as unknown[]).map((item, index) => [String(index), item] as const)
    : Object.entries(node as Record<string, unknown>)
  for (const [key, value] of entries) {
    const childLocator = isArray ? `${locator}[${key}]` : `${locator}.${key}`
    if (typeof value === 'string') {
      classifyString(storeKey, childLocator, key, value, ctx, node)
      continue
    }
    if (isContainer(value)) walkNested(value, storeKey, childLocator, ctx)
  }
}

/**
 * 遍历一条记录（如一篇 `PaperRecord`）的字段：这一层的字段名才可能是白名单字段。
 */
function walkRecordFields(record: Record<string, unknown>, storeKey: string, locator: string, ctx: AuditContext): void {
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      classifyString(storeKey, locator, field, value, ctx, record)
      continue
    }
    if (isContainer(value)) walkNested(value, storeKey, `${locator}.${field}`, ctx)
  }
}

/**
 * 只读审计空间层 store：产出四桶报告，**不修改入参**。
 *
 * 遍历方式：对 store 的**每个顶层键**递归下降（对象与数组都走），但**改写判定只认白名单
 * 字段路径**（顶层键 + 记录字段名）；其余字段的字符串只在「绝对路径样」时进 `observed`。
 */
export function auditSpaceStore(
  store: Record<string, unknown>,
  oldRoot: string,
  newRoot: string,
  opts: RemapOptions = {}
): RemapAuditReport {
  const known = new WeakMap<object, Set<string>>()
  for (const ref of collectPathReferences(store)) {
    const fields = known.get(ref.container) ?? new Set<string>()
    fields.add(ref.field)
    known.set(ref.container, fields)
  }
  const ctx: AuditContext = { known, oldRoot, newRoot, opts, found: [], rewritten: [], skipped: [], observed: [] }

  for (const [storeKey, table] of Object.entries(store)) {
    // 顶层键直接是字符串（极少见）：非白名单层，只观察。
    if (typeof table === 'string') {
      if (isAbsolutePathLike(table)) ctx.observed.push({ storeKey, locator: '', field: storeKey, value: table })
      continue
    }
    if (Array.isArray(table)) {
      table.forEach((record, index) => {
        const locator = `[${index}]`
        if (typeof record === 'string') {
          if (isAbsolutePathLike(record)) ctx.observed.push({ storeKey, locator, field: storeKey, value: record })
          return
        }
        if (isContainer(record)) walkRecordFields(record as Record<string, unknown>, storeKey, locator, ctx)
      })
      continue
    }
    if (isPlainObject(table)) {
      // ⚠️ `library:papers` 是 Record（按 arxivId 键控），故用 Object.entries 而非数组下标。
      for (const [recordKey, record] of Object.entries(table)) {
        if (typeof record === 'string') {
          if (isAbsolutePathLike(record)) ctx.observed.push({ storeKey, locator: recordKey, field: recordKey, value: record })
          continue
        }
        if (isContainer(record)) walkRecordFields(record as Record<string, unknown>, storeKey, recordKey, ctx)
      }
    }
  }

  return { found: ctx.found, rewritten: ctx.rewritten, skipped: ctx.skipped, observed: ctx.observed }
}

/**
 * 审计**暂存根**内的空间层 `store.json`（本文件唯一的 IO 函数）。
 *
 * 读 `<stagingRoot>/.mimir/store.json` → `JSON.parse` → 交给上面的纯函数审计。
 *
 * @throws RestoreError `RECHECK_FAILED` 读取失败 / JSON 解析失败 / 顶层不是对象
 */
export function auditStagedSpaceStore(
  stagingRoot: string,
  oldRoot: string,
  newRoot: string,
  opts: RemapOptions = {}
): RemapAuditReport {
  const storePath = join(stagingRoot, '.mimir', 'store.json')
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
  if (!isPlainObject(parsed)) {
    throw new RestoreError('RECHECK_FAILED', `暂存空间层 store.json 顶层不是对象：${storePath}`)
  }
  return auditSpaceStore(parsed, oldRoot, newRoot, opts)
}
