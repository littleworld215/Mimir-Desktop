/**
 * 注册表追加（I6 批次 3 · 第 4 块）。
 *
 * 职责：把已发布的新空间**只追加**一条登记到本机注册表 `~/.mimir/store.json`。
 *
 * 纪律（对应 `docs/design/I6-BATCH3-RESTORE.md` §4.2 S1–S10）：
 * - **S2 绝不 `loadStore()`**：它会自动迁移、创建默认空间并写全局指针（`active`/`default`）——
 *   在「恢复」语境下这等于替用户做决定。因此本模块**自己读原始 JSON**，只操作那一个对象。
 *   同理**不使用** `saveWorkspaces`（模块私有）与 `setActiveWorkspaceId`（会改指针）。
 * - **S1 只追加**：`settings` / `servers:list` / `activeWorkspaceId` / `defaultWorkspaceId`
 *   及其它既有键**逐字保留**（整体展开后仅替换 `workspaces:list`）。
 * - **S3 本机保护快照**：写前把原文件**字节**复制为 `store.json.pre-restore-<ISO>-<短uuid>.bak`；
 *   命名**故意**不匹配保留策略的 prune 模式（prune 不得清理它）。
 * - **S4 原子写**：同目录临时文件 → `writeFileSync` → `renameSync`；失败清临时文件并上抛。
 * - **S9 幂等重试**：`id` 已存在则 `appended:false` 直接返回，避免 retry 产生重复记录。
 * - **S7 路径只由主进程生成**：入参 `path` 必须是绝对路径，否则 `REGISTRY_INVALID`。
 *
 * ⚠️ 与设计稿的两处实测更正（team-lead 复核结论）：
 * 1. 设计 §0 写的「`writeJsonAtomic`（经 `store.ts`）」**不可用**：它在 `electron/library/store.ts:294`
 *    是**模块私有未导出**，且内部第 306 行调 `assertSwitchProtection()`——那是绑在**当前激活
 *    科研空间**上的切换保护；恢复注册的是一个**全新空间**，复用它会让注册错误地依赖
 *    「当前激活空间的保护状态」。因此这里自实现 `writeRegistryAtomic`（**不改动 store.ts**）。
 * 2. 权限位**固定按凭据模式 0600**：`saveGlobal()`（`store.ts:325`）对注册表这个文件本来就固定
 *    传 `{ credential: true }`，故不需要复制 `containsCredentialKeys` 的凭据键名正则，不存在
 *    逻辑分叉。`chmodSync` 在 win32 跳过（对齐 `tightenFileMode`）。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RestoreError } from './restoreContracts'
import { readRegistryOverview } from './registryView'

/** 注册表文件名（本机，非空间层）。 */
const REGISTRY_FILE_NAME = 'store.json'
/** 本机保护快照前缀：命名故意不匹配保留策略的 prune 模式（prune 不得清理它）。 */
export const REGISTRY_SNAPSHOT_PREFIX = `${REGISTRY_FILE_NAME}.pre-restore-`
/** 注册表固定按凭据文件权限（与 `saveGlobal()` 一致）。 */
const CREDENTIAL_FILE_MODE = 0o600

/** 待追加的一条空间登记。 */
export interface RegistryAppendInput {
  /** 新空间 id（新 UUID）。 */
  readonly id: string
  readonly name: string
  /** 新空间根（**绝对**路径，只由主进程生成）。 */
  readonly path: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 追加结果：`appended:false` 表示 id 已存在（幂等，未重复写入）。 */
export interface RegistryAppendOutcome {
  readonly appended: boolean
  /** 本次写入前的原字节快照路径。 */
  readonly snapshotPath: string
  /** 写入后 `workspaces:list` 的条目总数。 */
  readonly spaces: number
}

/** 注册表文件路径（`<home>/.mimir/store.json`）。 */
function registryFilePath(homeDir: string): string {
  return join(homeDir, '.mimir', REGISTRY_FILE_NAME)
}

/** ISO 时间戳（去掉 Windows 文件名非法的 `:` 与 `.`）。 */
function stampForFileName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * 原子写 JSON：同目录临时文件 → `writeFileSync` → `renameSync`。
 *
 * 失败时清理临时文件并**上抛**（绝不静默吞错，防止「看似成功实则丢数据」）。
 *
 * @throws RestoreError `REGISTER_FAILED`（写入或 rename 失败）
 */
export function writeRegistryAtomic(path: string, value: Record<string, unknown>): void {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      throw new RestoreError('REGISTER_FAILED', `注册表目录创建失败：${dir}（${(error as Error).message}）`)
    }
  }
  const tempPath = join(dir, `.tmp-${basename(path)}-${process.pid}-${randomUUID()}`)
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: CREDENTIAL_FILE_MODE })
    renameSync(tempPath, path)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件清理失败可忽略；原始错误继续上抛（否则会误判为成功）。
    }
    throw new RestoreError('REGISTER_FAILED', `注册表原子写失败：${path}（${(error as Error).message}）`)
  }
  // 兜底收紧权限（仅 POSIX；Windows 无 POSIX 权限位，跳过）。
  // 收紧失败不判失败：权限是「降低暴露面」，与写入是否成功是两个维度。
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, CREDENTIAL_FILE_MODE)
    } catch {
      // 忽略
    }
  }
}

/**
 * 本机保护快照：把注册表原**字节**复制一份（写前调用）。
 *
 * @returns 快照路径 `<home>/.mimir/store.json.pre-restore-<ISO>-<短uuid>.bak`
 * @throws RestoreError `REGISTRY_INVALID`（原文件不存在）
 */
export function snapshotRegistryFile(homeDir: string): string {
  const path = registryFilePath(homeDir)
  if (!existsSync(path)) {
    throw new RestoreError('REGISTRY_INVALID', `注册表文件不存在，无法快照：${path}`)
  }
  // 短 uuid 后缀：同毫秒内连续重试不会互相覆盖快照。
  const snapshotPath = join(dirname(path), `${REGISTRY_SNAPSHOT_PREFIX}${stampForFileName(new Date())}-${randomUUID().slice(0, 8)}.bak`)
  try {
    copyFileSync(path, snapshotPath)
  } catch (error) {
    throw new RestoreError('REGISTER_FAILED', `注册表快照失败：${snapshotPath}（${(error as Error).message}）`)
  }
  return snapshotPath
}

/** 读取注册表**原始**对象（不用 `loadStore()`，见文件头 S2 说明）。 */
function readRegistryRaw(homeDir: string): Record<string, unknown> {
  const path = registryFilePath(homeDir)
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new RestoreError('REGISTRY_INVALID', `注册表读取失败：${path}（${(error as Error).message}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RestoreError('REGISTRY_INVALID', `注册表不是合法 JSON：${path}（${(error as Error).message}）`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RestoreError('REGISTRY_INVALID', `注册表顶层不是 JSON 对象：${path}`)
  }
  return parsed as Record<string, unknown>
}

/** 取出 `workspaces:list`（缺失视为空表；存在但非数组 → `REGISTRY_INVALID`）。 */
function readSpacesList(registry: Record<string, unknown>, path: string): Array<Record<string, unknown>> {
  const list = registry['workspaces:list']
  if (list === undefined) return []
  if (!Array.isArray(list)) {
    throw new RestoreError('REGISTRY_INVALID', `注册表 workspaces:list 不是数组：${path}`)
  }
  return list as Array<Record<string, unknown>>
}

/**
 * 只追加一条空间登记（S1–S10）。
 *
 * 顺序：① 读原始 JSON ② 快照原字节 ③ id 已存在 → 幂等返回 ④ 只替换 `workspaces:list`
 * ⑤ 原子写 ⑥ 用 `readRegistryOverview` 复核新 id 存在。
 *
 * @throws RestoreError `REGISTRY_INVALID`（注册表损坏 / 入参非法）| `REGISTER_FAILED`（写失败 / 复核失败）
 */
export function appendWorkspaceRecord(homeDir: string, input: RegistryAppendInput): RegistryAppendOutcome {
  // 入参校验（S7：路径只由主进程生成，必须是绝对路径）。
  if (input.id.trim() === '' || input.name.trim() === '' || input.path.trim() === '') {
    throw new RestoreError('REGISTRY_INVALID', '追加登记失败：id / name / path 均不得为空。')
  }
  if (!isAbsolute(input.path)) {
    throw new RestoreError('REGISTRY_INVALID', `追加登记失败：空间路径必须是绝对路径：${input.path}`)
  }

  const path = registryFilePath(homeDir)
  // ① 原始对象（绝不走 loadStore）
  const registry = readRegistryRaw(homeDir)
  // ② 本机保护快照（写在最前，任何后续失败都有原字节可回滚）
  const snapshotPath = snapshotRegistryFile(homeDir)
  // ③ 幂等（S9）：retry 不得产生重复记录
  const spaces = readSpacesList(registry, path)
  const existing = spaces.find((space) => space['id'] === input.id)
  if (existing !== undefined) {
    return { appended: false, snapshotPath, spaces: spaces.length }
  }

  // ④ 只替换 workspaces:list；其余键（settings / servers:list / active / default …）逐字保留。
  const record: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    path: input.path,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  }
  const next: Record<string, unknown> = { ...registry, 'workspaces:list': [...spaces, record] }

  // ⑤ 原子写（失败上抛 REGISTER_FAILED）
  writeRegistryAtomic(path, next)

  // ⑥ 复核：新 id 必须出现在注册表概览里（读不到 = 注册未完成，绝不静默成功）。
  let view: Array<{ id: string; name: string }> = []
  try {
    view = readRegistryOverview(homeDir)
  } catch (error) {
    throw new RestoreError('REGISTER_FAILED', `注册复核失败（注册表已写入但读回校验不通过）：${path}（${(error as Error).message}）`)
  }
  if (!view.some((space) => space.id === input.id)) {
    throw new RestoreError('REGISTER_FAILED', `注册复核失败：新空间 id 未出现在注册表中：${input.id}`)
  }

  return { appended: true, snapshotPath, spaces: spaces.length + 1 }
}
