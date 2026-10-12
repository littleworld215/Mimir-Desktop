/**
 * 目录发布（I6 批次 3 · 第 4 块）。
 *
 * 职责：把已解压并复校通过的**暂存根**原子发布成目标新空间目录（同盘 `rename`），
 * 并在发布前完成 S8 的链接拒绝检查。
 *
 * 纪律（对应 `docs/design/I6-BATCH3-RESTORE.md` §2.2 / §2.3 / §4.2 S8）：
 * - **绝不覆盖**：rename **前**预检目标、rename **后**再复核（双检）；命中即 `TARGET_EXISTS`，
 *   且**不得改动**已存在的目标目录（失败组有「既有目录逐字未动」断言）。
 * - **链接拒绝（S8）**：`<stagingRoot>/.mimir` 与 `<stagingRoot>/assets` 任一为链接 → `UNSAFE_ENTRY`。
 *   双检手段：`lstatSync`（看自身是不是链接）+ `realpathSync`（看解析后是否仍在暂存根内）。
 * - **失败保留暂存**：rename 失败 → `PUBLISH_FAILED`，**不删暂存根**，供用户改到同盘后 `retry`。
 * - 本模块只做「发布」这一件事：不解压、不改内容、不写注册表（那是 T04 编排的职责）。
 */

import { existsSync, lstatSync, realpathSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { RestoreError } from './restoreContracts'

/** 发布结果（发布成功 = 暂存根已被 rename 消费，目标目录就位）。 */
export interface PublishOutcome {
  /** 已发布的目标新空间根。 */
  readonly targetRoot: string
}

/** S8 要求双检的两个目录：控制目录与资产目录。 */
const PROTECTED_DIRECTORIES = ['.mimir', 'assets'] as const

/** 统一为正斜杠并按平台决定大小写敏感性（realpath 可能返回不同大小写）。 */
function normalizeForCompare(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/** 判断 `child` 是否位于 `root` 之内（含相等）。 */
function isWithinRoot(child: string, root: string): boolean {
  const caseInsensitive = process.platform === 'win32'
  const normalizedRoot = normalizeForCompare(root, caseInsensitive)
  const normalizedChild = normalizeForCompare(child, caseInsensitive)
  if (normalizedChild === normalizedRoot) return true
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  return normalizedChild.startsWith(prefix)
}

/**
 * S8：暂存根内的 `.mimir` / `assets` 不得为符号链接或 junction。
 *
 * 双检理由（缺一不可）：
 * - 只看 `lstatSync().isSymbolicLink()` 会漏掉「父路径被链接出去」的情形；
 * - 只看 `realpathSync()` 会在链接指向暂存根内部时误放行。
 *
 * 目录不存在时不报错（小型空间可能没有 assets 目录）——S8 约束的是「不得为链接」。
 *
 * @throws RestoreError `UNSAFE_ENTRY`（是链接 / 解析到暂存根之外）| `PUBLISH_FAILED`（暂存根不存在）
 */
export function assertPublishableStaging(stagingRoot: string): void {
  if (stagingRoot.trim() === '') {
    throw new RestoreError('PUBLISH_FAILED', '暂存根路径为空，无法发布。')
  }
  if (!existsSync(stagingRoot)) {
    throw new RestoreError('PUBLISH_FAILED', `暂存根不存在，无法发布：${stagingRoot}`)
  }

  let rootReal = ''
  try {
    rootReal = realpathSync(stagingRoot)
  } catch (error) {
    throw new RestoreError('PUBLISH_FAILED', `暂存根 realpath 解析失败：${stagingRoot}（${(error as Error).message}）`)
  }

  for (const name of PROTECTED_DIRECTORIES) {
    const path = join(stagingRoot, name)
    // 存在性探测必须用 `lstatSync` 而非 `existsSync`：`existsSync` 会**跟随**链接，
    // 悬垂符号链接（指向不存在目标）会被判为「不存在」而**整体跳过**本项检查，
    // 使一条悬垂链接绕过 S8。`lstatSync` 不跟随链接，故能如实看到链接自身。
    // ENOENT 才是「真的没有这个目录」（小型空间可能没有 assets）→ 跳过；其余错误一律拒绝。
    let stat
    try {
      stat = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new RestoreError('UNSAFE_ENTRY', `暂存根内的 ${name} 无法 stat，拒绝发布：${path}（${(error as Error).message}）`)
    }
    if (stat.isSymbolicLink()) {
      throw new RestoreError('UNSAFE_ENTRY', `暂存根内的 ${name} 是符号链接/junction，拒绝发布：${path}`)
    }
    let real = ''
    try {
      real = realpathSync(path)
    } catch (error) {
      throw new RestoreError('UNSAFE_ENTRY', `暂存根内的 ${name} realpath 解析失败，拒绝发布：${path}（${(error as Error).message}）`)
    }
    if (!isWithinRoot(real, rootReal)) {
      throw new RestoreError('UNSAFE_ENTRY', `暂存根内的 ${name} 解析到暂存根之外，拒绝发布：${real}`)
    }
  }
}

/**
 * rename 的 errno 归类：目标已存在（哪怕落在预检与 rename 之间的竞态窗口里）一律算
 * `TARGET_EXISTS`，而不是笼统的 `PUBLISH_FAILED`——覆盖防护必须有确定的错误码。
 */
function isTargetExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

/**
 * 同盘原子发布：暂存根 `rename` 成目标目录。
 *
 * 顺序：链接双检 → rename 前预检 → rename → rename 后复核。
 * 任何失败都**保留暂存根**（不删），交由上层进入 `publishFail` 与 `retry`。
 *
 * @throws RestoreError `TARGET_EXISTS`（目标已存在，绝不覆盖）| `UNSAFE_ENTRY`（链接）|
 *                      `PUBLISH_FAILED`（rename 失败 / 发布后复核失败）
 */
export function publishStagedSpace(stagingRoot: string, targetRoot: string): PublishOutcome {
  if (targetRoot.trim() === '') {
    throw new RestoreError('INVALID_TARGET', '目标空间路径为空，无法发布。')
  }
  // ① 链接拒绝（S8）：发布前先确认暂存根内受保护目录不是链接。
  assertPublishableStaging(stagingRoot)

  // ② rename 前预检：目标必须不存在（拒绝覆盖既有目录/文件）。
  if (existsSync(targetRoot)) {
    throw new RestoreError('TARGET_EXISTS', `目标已存在，拒绝覆盖：${targetRoot}`)
  }

  // ③ 同盘 rename：这是发布动作本体（跨卷会被系统拒绝 → PUBLISH_FAILED）。
  try {
    renameSync(stagingRoot, targetRoot)
  } catch (error) {
    if (isTargetExistsError(error)) {
      throw new RestoreError('TARGET_EXISTS', `目标已存在，拒绝覆盖：${targetRoot}（${(error as Error).message}）`)
    }
    // 保留暂存根（刻意不删）：供用户改到同盘后 retry。
    throw new RestoreError('PUBLISH_FAILED', `暂存根发布失败（已保留暂存根 ${stagingRoot}）：${(error as Error).message}`)
  }

  // ④ rename 后复核：目标必须真的出现，且暂存根已被消费。
  if (!existsSync(targetRoot)) {
    throw new RestoreError('PUBLISH_FAILED', `发布后目标目录不存在，发布未完成：${targetRoot}`)
  }
  if (existsSync(stagingRoot)) {
    throw new RestoreError('PUBLISH_FAILED', `发布后暂存根仍存在，发布未完成：${stagingRoot}`)
  }

  return { targetRoot }
}
