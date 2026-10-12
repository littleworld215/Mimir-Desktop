/**
 * 保留预览与显式清理服务层（I6 批次 5 · T02）。
 *
 * 职责：把 T01 的纯函数（`listManagedArchives` / `planRetention` / `createRetentionToken`）
 * 组装成**两个 IPC 动作的服务端**：
 * - `buildRetentionPreview(deps)`：只读预览。算计划 → 生成一次性 `confirmToken` → 返回**脱敏**
 *   视图（只有文件名 / 字节 / 时间 / 处置 / 原因，**绝不含绝对路径**）。
 * - `applyRetention(token, deps)`：显式清理。**严格按设计 §2.2 六步**：重算 → 校验 token →
 *   逐条（先删最早）双重复核后删除 → 幂等 → 失败不中止 → 审计。
 *
 * ── 三条铁律（对齐设计 §0.3 / 风险表 K1/K2/K3/K5） ────────────────────────
 * 1. **只收 token，绝不收路径**（K2）：`applyRetention` 的入参**只有一个** token；删除目标
 *    一律由本服务**自己重算**（`listManagedArchives` + `planRetention`）。渲染层无法指定删谁。
 * 2. **不匹配即零副作用**（K3）：token 与当前候选集不符 → 立即返回 `TOKEN_MISMATCH`，
 *    **一个文件都不删**、**一条审计都不写**（未动盘就不该留「执行过」的记录）。
 * 3. **绝不触碰不可变快照**（K1/K7）：候选由 `listManagedArchives` 白名单保证；此外本服务在
 *    **删除前对每条再复核一次**——`isManagedArchive(basename)` + 路径 `path.resolve` 后确在
 *    `backupsDir` 内（双重复核，防御纵深）。
 *
 * ── 无后台清理（D-032 铁律 / K4） ─────────────────────────────────────────
 * 本模块**没有**定时器 / 启动钩子 / `setInterval`。清理**只**在 `applyRetention` 被显式调用时
 * 发生，且必须带一个与当前候选集匹配的 token。
 *
 * ── IO 可注入（便于单测隔离） ─────────────────────────────────────────────
 * `RetentionDeps` 的 `listArchives` / `removeFile` / `writeAudit` 全部可注入。生产默认走真实
 * `fs` 与批次 4 的 `auditWriter`；单测注入假实现即可在 `mkdtemp` 合成 home 上跑，无需真实 Electron。
 */

import { existsSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

import type {
  MaintenanceAuditEntry,
  MaintenanceRetentionItem,
  MaintenanceRetentionPreview,
  MaintenanceRetentionResult
} from '../../shared/workspaceBackupContracts'
import { listManagedArchives } from './archiveScan'
import { isManagedArchive } from './archiveNaming'
// 归档目录名收口为共享常量（I6 批次 3.5 · T01）：与 maintenanceMain / doctor 同一事实源。
import { ARCHIVE_DIRECTORY_NAME } from './directories'
import { planRetention, type RetentionCandidate, type RetentionPolicy } from './retentionPolicy'
import { createRetentionToken, verifyRetentionToken } from './retentionToken'
import { appendMaintenanceAudit } from './auditWriter'

/** 默认保留份数（**固定边界明文 20**，设计 §8 U1）。 */
export const DEFAULT_RETENTION_KEEP = 20
/** 默认保护窗口天数（**0 = 不启用**，设计 §8 U2）。 */
export const DEFAULT_RETENTION_KEEP_DAYS = 0

/**
 * 服务层依赖（全部可注入以便隔离 IO / 单测）。
 *
 * 除 `home` 外全部可选，缺省即生产行为。
 */
export interface RetentionDeps {
  /** 用户 home 目录（本机数据根；清理目标 = `<home>/backups`，审计落 `<home>/.mimir/logs`）。 */
  readonly home: string
  /** 归档目录；缺省 `join(home, ARCHIVE_DIRECTORY_NAME)`。 */
  readonly backupsDir?: string
  /** 保留最新份数；缺省 20。 */
  readonly keep?: number
  /** 保护窗口天数；缺省 0（不启用）。 */
  readonly keepDays?: number
  /** 注入时钟（测试用）；缺省 `new Date()`。 */
  readonly now?: () => Date
  /** 注入只读扫描（测试隔离 IO）；缺省 `listManagedArchives`。 */
  readonly listArchives?: (dir: string) => RetentionCandidate[]
  /** 注入删除动作（测试注入失败 / 模拟 ENOENT）；缺省用 `fs.rmSync(force)`。 */
  readonly removeFile?: (path: string) => void
  /** 注入审计写入（测试捕获）；缺省 `appendMaintenanceAudit`。 */
  readonly writeAudit?: (home: string, entry: MaintenanceAuditEntry) => void
}

/** 解析后的有效依赖（缺省值补齐）。 */
interface ResolvedDeps {
  readonly home: string
  readonly backupsDir: string
  readonly policy: RetentionPolicy
  readonly now: () => Date
  readonly listArchives: (dir: string) => RetentionCandidate[]
  readonly removeFile: (path: string) => void
  readonly writeAudit: (home: string, entry: MaintenanceAuditEntry) => void
}

/** 把可选依赖补齐为有效依赖。 */
function resolveDeps(deps: RetentionDeps): ResolvedDeps {
  return {
    home: deps.home,
    backupsDir: deps.backupsDir ?? join(deps.home, ARCHIVE_DIRECTORY_NAME),
    policy: {
      keep: deps.keep ?? DEFAULT_RETENTION_KEEP,
      keepDays: deps.keepDays ?? DEFAULT_RETENTION_KEEP_DAYS
    },
    now: deps.now ?? (() => new Date()),
    listArchives: deps.listArchives ?? listManagedArchives,
    // `force:true` 让「文件已不存在」静默成功（幂等语义）；`rmSync` 对符号链接只删链接本身。
    removeFile: deps.removeFile ?? ((path: string) => rmSync(path, { force: true })),
    writeAudit: deps.writeAudit ?? appendMaintenanceAudit
  }
}

/**
 * 把服务层的候选裁剪成**渲染层可见**的脱敏条目。
 *
 * ⚠️ **绝不带出绝对路径**：`name` 用 `basename` 再兜底一道（即便上游 `candidate.name` 已是
 * basename，这里也不信任——对齐批次 3 §4.3 / 批次 4 §4.3 的单向裁剪纪律，参照
 * `maintenanceRestoreHandler.toRestoreResult`）。
 *
 * @param candidate 服务层候选（含绝对路径）。
 * @param disposition 处置（保留 / 清理）。
 * @param reason 原因（`recent` / `within-days` / `beyond-keep`）。
 * @returns 脱敏条目。
 */
function toRetentionItem(
  candidate: RetentionCandidate,
  disposition: 'keep' | 'remove',
  reason: string
): MaintenanceRetentionItem {
  return {
    name: basename(candidate.name),
    bytes: candidate.bytes,
    modifiedAt: candidate.modifiedAt,
    disposition,
    reason
  }
}

/**
 * 只读预览：返回**脱敏**视图 + 一次性 `confirmToken`。
 *
 * 步骤：`listManagedArchives(backupsDir)` → `planRetention(archives, policy, now)` →
 * 对**清理候选**生成 token → 逐条裁剪成脱敏条目。
 *
 * ⚠️ **只读**：不建目录、不写文件、不取锁（`listArchives` 缺省实现只 `readdir`/`stat`）。
 *
 * ⚠️ token 绑定的是**清理候选**（即 `plan.candidates`）——因为「确认清理」要防的正是
 * 「预览说删这 M 份，执行时磁盘上已不是这 M 份」。保留项变化（如新增一份最新归档）会挤动
 * 候选集，从而同样使 token 失配，这正是「防过期」想要的。
 *
 * @param deps 服务层依赖（`home` 必填）。
 * @returns 预览结果（成功含 `confirmToken` / `keepPolicy`；失败只出 `{ok:false,code,detail}`）。
 */
export function buildRetentionPreview(deps: RetentionDeps): MaintenanceRetentionPreview {
  const resolved = resolveDeps(deps)

  // 重算候选（**主进程自己算**，不信任何外部传入的列表）。
  const archives = resolved.listArchives(resolved.backupsDir)
  const plan = planRetention(archives, resolved.policy, resolved.now())

  // 脱敏条目：保留项 disposition='keep'，清理候选 disposition='remove'。
  const items: MaintenanceRetentionItem[] = [
    ...plan.keep.map((k) => toRetentionItem(k, 'keep', k.reason)),
    ...plan.candidates.map((c) => toRetentionItem(c, 'remove', c.reason))
  ]

  // token 绑定**清理候选集**（见上方注释：防过期 / 防替换）。
  const confirmToken = createRetentionToken(plan.candidates)

  return {
    ok: true,
    items,
    reclaimableBytes: plan.reclaimableBytes,
    confirmToken,
    keepPolicy: resolved.policy.keep
  }
}

/**
 * 判定某路径确在 `backupsDir` **之内**（K7 防御：拒绝目录穿越 / 越界替换）。
 *
 * 用 `path.resolve` 归一化后做**前缀比较**（并附分隔符边界，防 `backupsEvil` 前缀误判为
 * 在 `backups` 内）。失败（空串 / 越界）→ `false`。
 *
 * @param target 待判定路径。
 * @param backupsDir 归档目录（已 resolve）。
 * @returns 确在目录内 → `true`。
 */
function isWithinDir(target: string, backupsDir: string): boolean {
  const resolvedTarget = resolve(target)
  const resolvedDir = resolve(backupsDir)
  if (resolvedTarget === resolvedDir) return false
  const withSep = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`
  return resolvedTarget.startsWith(withSep)
}

/**
 * 显式清理：重算候选 + 校验 token + 逐条删除 + 审计。**只收 token**。
 *
 * 严格按设计 §2.2 六步：
 * 1. **重算**：`listManagedArchives` + `planRetention`（**绝不信渲染层传的任何路径**）。
 * 2. **校验 token**：`verifyRetentionToken(token, 清理候选)`；不匹配 → `TOKEN_MISMATCH` 且
 *    **零副作用**（不删文件、不写审计）。
 * 3. **逐条删除，先删最早**：`plan.candidates` 按 `modifiedAt` 降序（末尾最早），故**倒序**遍历
 *    即「先删最早」。每条删前**双重复核**：`isManagedArchive(basename)` + 路径确在 `backupsDir` 内。
 * 4. **幂等**：文件已不存在 → 视为达成（`rmSync force` 静默成功；注入实现若抛 ENOENT 也按达成）。
 * 5. **失败不中止**：某条删除抛错 → 记 `failed`，**继续**其余；最终如实报告。
 * 6. **审计**：`writeAudit(home, { at, action:'retention', outcome, counts:{removed,failed,kept} })`。
 *
 * @param token 预览返回的一次性 token（**唯一入参**，渲染层不得传路径）。
 * @param deps 服务层依赖（`home` 必填）。
 * @returns 结果（成功 `{ok:true,removed,failed,reclaimedBytes}`；token 不匹配 → `TOKEN_MISMATCH`）。
 */
export function applyRetention(token: string, deps: RetentionDeps): MaintenanceRetentionResult {
  const resolved = resolveDeps(deps)

  // ── ① 重算（绝不信渲染层） ──────────────────────────────────────────────
  const archives = resolved.listArchives(resolved.backupsDir)
  const plan = planRetention(archives, resolved.policy, resolved.now())
  const removable = plan.candidates // 已按 modifiedAt 降序（末尾最早）

  // ── ② 校验 token（不匹配 → 零副作用） ───────────────────────────────────
  if (!verifyRetentionToken(token, removable)) {
    return {
      ok: false,
      code: 'TOKEN_MISMATCH',
      detail: '保留候选集已变化，请重新预览后再确认清理（未删除任何文件）。'
    }
  }

  // ── ③④⑤ 逐条删除：**先删最早** = 倒序遍历（末尾为最早） ────────────────
  let removed = 0
  let failed = 0
  let reclaimedBytes = 0
  const failedNames: string[] = []

  for (let i = removable.length - 1; i >= 0; i -= 1) {
    const candidate = removable[i]
    const fileName = basename(candidate.path)

    // ── ③ 删除前**双重复核**（防御纵深；K1/K7） ───────────────────────────
    //   复核 1：名字仍在白名单（防候选集在重算与删除之间被替换为非受管文件）。
    if (!isManagedArchive(fileName)) {
      failed += 1
      failedNames.push(fileName)
      continue
    }
    //   复核 2：路径确在 backupsDir 内（防符号链接 / 目录穿越把删除引到目录外）。
    if (!isWithinDir(candidate.path, resolved.backupsDir)) {
      failed += 1
      failedNames.push(fileName)
      continue
    }
    //   复核 3（补充）：符号链接 → 拒绝（`lstat` 语义下 `statSync` 会跟随链接；这里直接拒链，
    //   这与 `listManagedArchives` 的排除一致，是「绝不触碰」清单在删除路径上的再一道保险）。
    try {
      if (statSync(candidate.path).isSymbolicLink()) {
        failed += 1
        failedNames.push(fileName)
        continue
      }
    } catch (error) {
      // ── ④ 幂等：文件已不存在（ENOENT）→ 视为达成，记 removed（不报错） ──
      if ((error as { code?: unknown }).code === 'ENOENT') {
        removed += 1
        reclaimedBytes += candidate.bytes
        continue
      }
      // 其它 stat 错误（权限等）→ 记 failed，继续其余。
      failed += 1
      failedNames.push(fileName)
      continue
    }

    try {
      resolved.removeFile(candidate.path)
      removed += 1
      reclaimedBytes += candidate.bytes
    } catch (error) {
      // ── ④ 幂等：注入实现抛 ENOENT 也视为达成 ─────────────────────────────
      if ((error as { code?: unknown }).code === 'ENOENT') {
        removed += 1
        reclaimedBytes += candidate.bytes
        continue
      }
      // ── ⑤ 失败不中止：记 failed，继续其余 ───────────────────────────────
      failed += 1
      failedNames.push(fileName)
    }
  }

  // ── ⑥ 审计（复用批次 4 auditWriter；失败仅 warn，不拖垮清理） ───────────
  const kept = plan.keep.length
  const outcome: 'ok' | 'failed' = failed > 0 ? 'failed' : 'ok'
  // `action:'retention'` 已在共享契约的 `MaintenanceAuditEntry.action` 联合类型中登记
  // （批次 5 收口时补入），故此处**无需**任何类型断言——保持类型诚实。
  const entry: MaintenanceAuditEntry = {
    at: resolved.now().toISOString(),
    action: 'retention',
    outcome,
    code: failed > 0 ? 'PARTIAL_FAILURE' : undefined,
    counts: { removed, failed, kept },
    // labels 的值只允许**文件名 basename**（绝不含绝对路径）；这里放失败条目名，便于人工定位。
    labels: failedNames.length > 0 ? { failed: failedNames.join(',') } : undefined
  }
  resolved.writeAudit(resolved.home, entry)

  return { ok: true, removed, failed, reclaimedBytes }
}

/**
 * 便捷断言：给定路径是否存在（供调用方/测试判断，**不改变清理语义**）。
 *
 * 保留导出是为了让「幂等 / 存活断言」在服务层有单一口径；不参与删除决策。
 *
 * @param path 待判定路径。
 * @returns 存在 → `true`。
 */
export function retentionPathExists(path: string): boolean {
  return existsSync(path)
}
