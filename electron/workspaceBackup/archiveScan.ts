/**
 * 受管归档只读扫描（I6 批次 5 · T01）。
 *
 * 职责：只读扫描 `backups/` 目录，返回**仅**本应用产出的整空间归档（`RetentionCandidate[]`）。
 * 白名单过滤**在本函数内**完成，是「绝不触碰不可变快照」的实现保证（设计 §1.3）。
 *
 * ── 与 `restoreMain.listRestoreArchives`（`:133` 只读扫描范本）的关系 ──────────
 * 两者形态一致（`existsSync` 早退 → `readdirSync(withFileTypes)` → 逐条 `statSync` 容错 →
 * 按 `modifiedAt` 降序）。差异在**过滤口径**：恢复列表按 `.zip$` 宽松收集（要列出用户所有
 * 归档，含非本应用产出的），而本函数按 `isManagedArchive` **严格白名单**收集——因为它的
 * 下游是**删除**，绝不能宽容。故本函数刻意**不复用**恢复列表，避免把「宽松」和「严格」
 * 两种语义混进一个函数。
 *
 * ── 三重显式排除（设计 §0.2 / §1.3；不是「恰好没匹配」） ───────────────────
 * 三类**绝不可被清理**的产物在代码里逐条写成显式 `if (...) continue`，让「绝不触碰」是
 * **可审计的代码**而非巧合（对齐 D-032 决策 5 的清单）：
 *   ① `.partial`（打包中暂存名，尚未发布）；
 *   ② 本机注册前快照 `store.json.pre-restore-*`（`REGISTRY_SNAPSHOT_PREFIX`）；
 *   ③ 符号链接（`isSymbolicLink()`，防指向空间外文件被误删，K7）。
 * 注：迁移前快照 `schema-<v>-<ts>-<uuid>.db` **天然**不匹配 `.zip$` 后缀；但本函数靠
 * `isManagedArchive` 严格白名单（只认 `mimir-backup-*.zip`）即可整体拒绝，无需单列一条。
 *
 * 只读纪律：目录不存在 → `[]`，**绝不建目录**（读路径零副作用，对齐 `auditReader`）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

import { isManagedArchive } from './archiveNaming'
import { REGISTRY_SNAPSHOT_PREFIX } from './registryAppend'
import type { RetentionCandidate } from './retentionPolicy'

/**
 * 只读扫描某目录，返回**仅**本应用产出的归档（白名单过滤在本函数内）。
 *
 * @param backupsDir 归档目录（生产 = `join(home, 'backups')`）。
 * @returns 受管归档候选，按 `modifiedAt` **降序**（最新在前）；目录不存在 → `[]`。
 */
export function listManagedArchives(backupsDir: string): RetentionCandidate[] {
  // 目录不存在 → 空列表。**不建目录**：扫描是只读动作（读路径零副作用）。
  if (!existsSync(backupsDir)) return []

  const out: RetentionCandidate[] = []
  for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
    // 只收普通文件（拒绝目录 / 设备等非常规项）。
    if (!entry.isFile()) continue

    // ── 排除 ①：打包中暂存名 `.partial`（尚未发布，是另一个动作的产物） ──────────
    // 显式判定而非依赖「恰好不匹配」：即使将来正则放宽，这条也守着。
    if (entry.name.endsWith('.partial')) continue

    // ── 排除 ②：本机注册前快照 `store.json.pre-restore-*`（REGISTRY_SNAPSHOT_PREFIX） ──
    // 这是 restore 动作写注册表前的字节保护快照，**绝不可清理**（命名故意不匹配 prune 模式）。
    // 用前缀判定，并附「含 `pre-restore`」的兜底，覆盖任何形态变体。
    if (entry.name.startsWith(REGISTRY_SNAPSHOT_PREFIX)) continue
    if (entry.name.includes('pre-restore')) continue

    // ── 排除 ③：符号链接（防指向 `backups/` 之外的文件被误删，K7 护栏） ──────────
    // `withFileTypes` 对符号链接的 `isFile()` 取决于目标；这里再显式判链接，双保险。
    if (entry.isSymbolicLink()) continue

    // ── 白名单：严格正则（唯一事实源在 `archiveNaming`） ──────────────────────
    if (!isManagedArchive(entry.name)) continue

    const path = join(backupsDir, entry.name)
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(path)
    } catch {
      // 单个条目 stat 失败（并发删除 / 权限）：跳过该条，不影响其余候选（对齐 listRestoreArchives）。
      continue
    }
    // 再次确认是普通文件（防 statSync 与 readdir 之间的 TOCTOU 变化）。
    if (!stats.isFile()) continue

    out.push({
      path: normalize(path),
      name: entry.name,
      bytes: stats.size,
      modifiedAt: stats.mtime.toISOString()
    })
  }

  // 按 `modifiedAt` 降序（与 planRetention 的排序口径一致）。
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}
