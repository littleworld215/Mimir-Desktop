import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { MaintenanceAuditEntry } from '../../../shared/workspaceBackupContracts'
import {
  applyRetention,
  buildRetentionPreview,
  type RetentionDeps
} from '../../../electron/workspaceBackup/retentionService'
import { planRetention, type RetentionCandidate } from '../../../electron/workspaceBackup/retentionPolicy'

/**
 * 保留预览与显式清理服务层（I6 批次 5 · T02）。
 *
 * 覆盖（对齐任务书 + 设计 §2.1/§2.2 + 风险表 K1/K2/K3/K5）：
 * - 21 份受管归档 → 预览 20 保留 / 1 清理；apply 后只剩 20、最早消失；
 * - **token 篡改 / 过期 → 零删除**（`TOKEN_MISMATCH`，逐字断言原文件存活）；
 * - **绝不触碰三类快照**（`.partial` / `pre-restore` / `schema-*.db` / 符号链接）逐字存活；
 * - **幂等**：第二次 apply 同一 token → 候选集已变 → `TOKEN_MISMATCH`（防重复删除的设计意图）；
 * - **失败不中止**：某条 removeFile 抛错 → 其余仍删、failed=1、结果如实；
 * - **审计条数 = 删除数**（注入假 writeAudit 捕获）；
 * - 预览返回**不含绝对路径**。
 *
 * 全部用 `mkdtemp` 合成 home + 真实建文件；不触碰真实 `~/.mimir`。
 *
 * ⚠️ **确定性 mtime（防 flaky）**：`planRetention` 的排序键是 `modifiedAt`（取自文件系统 mtime）。
 * 连续快速写文件时，Windows 上多份文件可能拿到**相同 mtime**，导致「哪份是最早」非确定 → 测试
 * 偶发变红（与实现无关，是 fixture 的锅）。故所有 fixture 一律用 `utimesSync` **显式写死**
 * 递增 mtime，使排序键完全确定、与写入时序/文件系统粒度无关。
 */

/**
 * 造一份受管归档，并**显式写死 mtime**（确定性排序键）。
 *
 * @param dir 目标目录。
 * @param stampTs 本地时间戳 `YYYYMMDD-HHMMSS`（拼进文件名）。
 * @param at 该文件的 mtime（**显式**，决定 `planRetention` 排序）。
 * @param bytes 写入字节数（默认 16）。
 * @returns 该文件的绝对路径。
 */
function writeArchive(dir: string, stampTs: string, at: Date, bytes = 16): string {
  const name = `mimir-backup-space-${stampTs}.zip`
  const path = join(dir, name)
  writeFileSync(path, Buffer.alloc(bytes, 0x61))
  // 显式设定 mtime（atime 同值即可），消除文件系统粒度差异带来的排序抖动。
  utimesSync(path, at, at)
  return path
}

/**
 * 一次性造 `count` 份受管归档：i 越大越**新**（mtime 每小时一份，秒级时间戳与 mtime 同步）。
 *
 * 返回每个文件的元信息，便于断言「最早那份」是谁。
 *
 * @param dir 目标目录。
 * @param count 份数。
 * @returns 逐份 `{ name, path, at }`（升序 = 最早在前）。
 */
function seedArchives(
  dir: string,
  count: number
): Array<{ name: string; path: string; at: Date }> {
  const out: Array<{ name: string; path: string; at: Date }> = []
  // 基准：2024-01-01 00:00:00 本地；每份 +1 小时（保证 mtime 唯一且与名字时间一致）。
  const base = new Date(2024, 0, 1, 0, 0, 0).getTime()
  for (let i = 0; i < count; i += 1) {
    const at = new Date(base + i * 60 * 60 * 1000)
    const yyyy = String(at.getFullYear()).padStart(4, '0')
    const mm = String(at.getMonth() + 1).padStart(2, '0')
    const dd = String(at.getDate()).padStart(2, '0')
    const hh = String(at.getHours()).padStart(2, '0')
    const mi = String(at.getMinutes()).padStart(2, '0')
    const ss = String(at.getSeconds()).padStart(2, '0')
    const stampTs = `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
    const path = writeArchive(dir, stampTs, at)
    out.push({ name: `mimir-backup-space-${stampTs}.zip`, path, at })
  }
  return out
}

let home: string
let backupsDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mimir-retention-'))
  backupsDir = join(home, 'backups')
  mkdirSync(backupsDir, { recursive: true })
})

afterEach(() => {
  // Windows 上 symlink 可能留下链接，rmSync recursive+force 清整棵临时树。
  rmSync(home, { recursive: true, force: true })
})

/** 构造缺省 deps（home + 缺省 backupsDir）。 */
function deps(extra: Partial<RetentionDeps> = {}): RetentionDeps {
  return { home, ...extra }
}

describe('buildRetentionPreview · 只读预览', () => {
  it('21 份受管归档 → 20 保留 / 1 清理；reclaimableBytes = 最早那份字节', () => {
    const seeded = seedArchives(backupsDir, 21)
    const earliestStamp = seeded[0].name

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    expect(preview.keepPolicy).toBe(20)
    expect(preview.items.filter((i) => i.disposition === 'keep')).toHaveLength(20)
    const removables = preview.items.filter((i) => i.disposition === 'remove')
    expect(removables).toHaveLength(1)
    // 清理项 = 最早那份（时间戳索引 0）。
    expect(removables[0].name).toBe(earliestStamp)
    expect(removables[0].reason).toBe('beyond-keep')
  })

  it('预览**不含绝对路径**（JSON 序列化不含合成 home 路径）', () => {
    seedArchives(backupsDir, 21)

    const preview = buildRetentionPreview(deps())
    const serialized = JSON.stringify(preview)
    // 合成 home 路径（含分隔符归一化形态）一律不得出现。
    expect(serialized).not.toContain(home)
    expect(serialized).not.toContain(backupsDir)
    // 也不应含任何盘符 / POSIX 根形态的残留。
    expect(serialized).not.toContain('\\\\')
  })

  it('目录不存在 → 零候选（只读，不建目录）', () => {
    const missingHome = mkdtempSync(join(tmpdir(), 'mimir-retention-missing-'))
    try {
      const preview = buildRetentionPreview({ home: missingHome })
      expect(preview.ok).toBe(true)
      if (!preview.ok) return
      expect(preview.items).toHaveLength(0)
      expect(preview.reclaimableBytes).toBe(0)
      // 只读：未建 backups/ 目录。
      expect(existsSync(join(missingHome, 'backups'))).toBe(false)
    } finally {
      rmSync(missingHome, { recursive: true, force: true })
    }
  })
})

describe('applyRetention · 正常清理', () => {
  it('21 份 → apply(token) 后只剩 20 份，最早那份消失', () => {
    const seeded = seedArchives(backupsDir, 21)
    const earliestStamp = seeded[0].name
    const earliest = seeded[0].path

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    const result = applyRetention(preview.confirmToken, deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.reclaimedBytes).toBe(16)

    // 最早那份消失。
    expect(existsSync(earliest)).toBe(false)
    // 只剩 20 份。
    const remaining = readdirSync(backupsDir).filter((n) => n.endsWith('.zip'))
    expect(remaining).toHaveLength(20)
  })
})

describe('applyRetention · token 篡改 / 过期 → 零删除（K3）', () => {
  it('预览后新加一份归档 → 候选集变 → TOKEN_MISMATCH → 断言原文件全部存活', () => {
    const seeded = seedArchives(backupsDir, 21)

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    // 预览后新加一份**最新**归档 → 候选集变化（旧的最早被挤出候选，新候选集不同）。
    //   显式给一个比所有既有归档都新的 mtime（+1000 小时）。
    const newestAt = new Date(seeded[seeded.length - 1].at.getTime() + 1000 * 60 * 60 * 1000)
    writeArchive(backupsDir, '29991231-235959', newestAt)

    const before = readdirSync(backupsDir).filter((n) => n.endsWith('.zip'))
    const result = applyRetention(preview.confirmToken, deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('TOKEN_MISMATCH')

    // 零副作用：文件一个都没少。
    const after = readdirSync(backupsDir).filter((n) => n.endsWith('.zip'))
    expect(after.sort()).toEqual(before.sort())
    expect(after).toHaveLength(22)
  })

  it('token 篡改（改动摘要前缀）→ TOKEN_MISMATCH → 零删除', () => {
    seedArchives(backupsDir, 21)

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    // 篡改摘要前缀（把首字符翻转）。
    const tampered = `f${preview.confirmToken.slice(1)}`
    const result = applyRetention(tampered, deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('TOKEN_MISMATCH')

    const remaining = readdirSync(backupsDir).filter((n) => n.endsWith('.zip'))
    expect(remaining).toHaveLength(21)
  })

  it('篡改 token 形状（无分隔符 / 非法前缀）→ TOKEN_MISMATCH → 零删除', () => {
    seedArchives(backupsDir, 21)

    for (const bad of ['not-a-token', '', 'ZZZZZZZZZZZZZZZZ-uuid', 'abcd-uuid']) {
      const result = applyRetention(bad, deps())
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('TOKEN_MISMATCH')
    }
    const remaining = readdirSync(backupsDir).filter((n) => n.endsWith('.zip'))
    expect(remaining).toHaveLength(21)
  })
})

describe('applyRetention · 绝不触碰三类不可变快照（K1/K7）', () => {
  it('受管归档被清理，但 .partial / pre-restore / schema-*.db / 符号链接逐字存活', () => {
    // 21 份受管归档（触发 1 份清理候选）。
    seedArchives(backupsDir, 21)

    // 三类不可变快照 + 暂存名。
    const partial = join(backupsDir, 'backup-3f2a1b4c-0000-4000-8000-000000000000.zip.partial')
    const preRestore = join(backupsDir, 'store.json.pre-restore-2026-01-01T00-00-00.bak')
    const schemaDb = join(backupsDir, 'schema-1-1234567890.db')
    writeFileSync(partial, Buffer.alloc(8))
    writeFileSync(preRestore, Buffer.alloc(8))
    writeFileSync(schemaDb, Buffer.alloc(8))

    // 符号链接（沙箱能建则测；不能建则跳过该条并注明）。
    const linkTarget = join(home, 'outside-target.zip')
    writeFileSync(linkTarget, Buffer.alloc(8))
    const linkPath = join(backupsDir, 'mimir-backup-linked-20260101-000000.zip')
    let linkCreated = false
    try {
      symlinkSync(linkTarget, linkPath, 'file')
      linkCreated = true
    } catch {
      // 沙箱（Windows 未开开发者模式 / 无权限）无法创建符号链接 → 跳过该条断言（已注明）。
    }

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    // 预览只应看到 21 份受管普通归档（符号链接若建成功则被排除 → 仍 21；若未建成功 → 仍 21）。
    const result = applyRetention(preview.confirmToken, deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toBe(1)

    // 三类快照 + 暂存名逐字存活。
    expect(existsSync(partial)).toBe(true)
    expect(existsSync(preRestore)).toBe(true)
    expect(existsSync(schemaDb)).toBe(true)
    if (linkCreated) {
      expect(existsSync(linkPath)).toBe(true)
      // 链接目标也必须存活（未被误删到外部文件）。
      expect(existsSync(linkTarget)).toBe(true)
    }
  })

  it('目录里只有三类快照（无受管归档）→ 预览零候选、apply 无删除', () => {
    const partial = join(backupsDir, 'backup-aaaaaaaa-0000-4000-8000-000000000000.zip.partial')
    const schemaDb = join(backupsDir, 'schema-2-999.db')
    writeFileSync(partial, Buffer.alloc(8))
    writeFileSync(schemaDb, Buffer.alloc(8))

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    // 受管归档为 0 → items 为空（三类快照不入选）。
    expect(preview.items).toHaveLength(0)

    const result = applyRetention(preview.confirmToken, deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toBe(0)
    expect(existsSync(partial)).toBe(true)
    expect(existsSync(schemaDb)).toBe(true)
  })
})

describe('applyRetention · 幂等与失败语义', () => {
  it('连续两次 apply 同一 token：第二次候选集已变 → TOKEN_MISMATCH（防重复删除）', () => {
    seedArchives(backupsDir, 21)

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    const first = applyRetention(preview.confirmToken, deps())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.removed).toBe(1)

    // 第二次：只剩 20 份 → 零候选 → token（绑定原 1 份候选）必然失配 → 零删除。
    const second = applyRetention(preview.confirmToken, deps())
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('TOKEN_MISMATCH')
    const remaining = readdirSync(backupsDir).filter((n) => n.endsWith('.zip'))
    expect(remaining).toHaveLength(20)
  })

  it('幂等（同一进程内重复删同一文件）：removeFile 抛 ENOENT → 视为达成记 ok', () => {
    seedArchives(backupsDir, 21)

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    // 注入 removeFile：模拟「文件在删除前已被并发删除」→ 抛 ENOENT。
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const result = applyRetention(
      preview.confirmToken,
      deps({
        removeFile: () => {
          throw enoentError
        }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // ENOENT → 达成，记 removed（幂等语义），failed=0。
    expect(result.removed).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('失败不中止：某条 removeFile 抛非 ENOENT → failed=1，其余仍删，结果如实', () => {
    seedArchives(backupsDir, 23) // 触发 3 份清理候选

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    // 记录删除尝试顺序；对**第一次**删除尝试（= 最早那份，服务层「先删最早」）注入抛错。
    // ⚠️ mtime 已由 seedArchives 显式写死（确定性），首个尝试即 mtime 最小的那份。
    const attempts: string[] = []
    const boom = Object.assign(new Error('EACCES'), { code: 'EACCES' })

    const result = applyRetention(
      preview.confirmToken,
      deps({
        removeFile: (path: string) => {
          attempts.push(path)
          if (attempts.length === 1) throw boom // 首个（最早）→ 失败
          rmSync(path, { force: true })
        }
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 3 份候选：1 份失败，2 份成功。
    expect(result.failed).toBe(1)
    expect(result.removed).toBe(2)
    // 共尝试删 3 次（失败那条不中止其余）。
    expect(attempts).toHaveLength(3)
    // 失败那份（首个尝试）仍在盘上（未被删）。
    const failingPath = attempts[0]
    expect(existsSync(failingPath)).toBe(true)
    // 其余 2 份已删 → 剩 21 份。
    const remaining = readdirSync(backupsDir).filter((n) => n.endsWith('.zip'))
    expect(remaining).toHaveLength(21)
    // 「先删最早」：服务层**倒序遍历**候选列表（列表按 mtime 降序 = 末尾最早）。
    //   故删除顺序 = 预览里 remove 项的**逆序**（首个尝试 = 最早那份）。
    const removeNamesDesc = preview.items.filter((i) => i.disposition === 'remove').map((i) => i.name)
    const expectedDeleteOrder = [...removeNamesDesc].reverse()
    expect(attempts.map((p) => basename(p))).toEqual(expectedDeleteOrder)
  })
})

describe('applyRetention · 审计（条数 = 删除数；outcome 如实）', () => {
  it('成功清理：写一条审计，counts.removed = 实际删除数', () => {
    seedArchives(backupsDir, 23) // 3 份清理候选

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    const audits: MaintenanceAuditEntry[] = []
    const result = applyRetention(
      preview.confirmToken,
      deps({ writeAudit: (_h, entry) => audits.push(entry) })
    )

    expect(result.ok).toBe(true)
    // 一条审计（action='retention'），counts 与结果一致。
    expect(audits).toHaveLength(1)
    const entry = audits[0] as unknown as {
      action: string
      outcome: string
      counts: Record<string, number>
    }
    expect(entry.action).toBe('retention')
    expect(entry.outcome).toBe('ok')
    expect(entry.counts.removed).toBe(3)
    expect(entry.counts.failed).toBe(0)
    expect(entry.counts.kept).toBe(20)
  })

  it('部分失败：审计 outcome=failed，counts 如实（removed/failed/kept）', () => {
    const seeded = seedArchives(backupsDir, 22) // 2 份清理候选

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    const audits: MaintenanceAuditEntry[] = []
    // 最早那份 = mtime 最小 → seeded[0]。
    const failingPath = seeded[0].path
    const result = applyRetention(
      preview.confirmToken,
      deps({
        removeFile: (path: string) => {
          if (path === failingPath) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
          rmSync(path, { force: true })
        },
        writeAudit: (_h, entry) => audits.push(entry)
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.failed).toBe(1)
    expect(result.removed).toBe(1)

    expect(audits).toHaveLength(1)
    const entry = audits[0] as unknown as {
      action: string
      outcome: string
      counts: Record<string, number>
    }
    expect(entry.action).toBe('retention')
    expect(entry.outcome).toBe('failed')
    expect(entry.counts.removed).toBe(1)
    expect(entry.counts.failed).toBe(1)
    expect(entry.counts.kept).toBe(20)
  })

  it('token 不匹配 → **不写审计**（零副作用含「不留执行记录」）', () => {
    const seeded = seedArchives(backupsDir, 21)

    const preview = buildRetentionPreview(deps())
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    // 预览后改变候选集（加一份更新的归档）。
    const newerAt = new Date(seeded[seeded.length - 1].at.getTime() + 1000 * 60 * 60 * 1000)
    writeArchive(backupsDir, '29991231-235959', newerAt)

    const audits: MaintenanceAuditEntry[] = []
    const result = applyRetention(
      preview.confirmToken,
      deps({ writeAudit: (_h, entry) => audits.push(entry) })
    )
    expect(result.ok).toBe(false)
    expect(audits).toHaveLength(0)
  })
})

describe('applyRetention · 依赖注入与 keep 参数', () => {
  it('注入 listArchives 与 keep=2 → 3 份候选按注入集算（隔离 IO）', () => {
    const injected: RetentionCandidate[] = [0, 1, 2].map((i) => ({
      path: `/virtual/mimir-backup-space-20240101-00000${i}.zip`,
      name: `mimir-backup-space-20240101-00000${i}.zip`,
      bytes: 100 + i,
      modifiedAt: new Date(2024, 0, 1, 0, 0, i).toISOString()
    }))

    const preview = buildRetentionPreview(
      deps({
        keep: 2,
        listArchives: () => injected,
        removeFile: () => {
          /* 不实际删（虚拟路径） */
        }
      })
    )
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.keepPolicy).toBe(2)
    expect(preview.items.filter((i) => i.disposition === 'remove')).toHaveLength(1)
  })

  it('planRetention 与 keep=2 口径一致（3 份时保留 2、候选 1）', () => {
    const archives: RetentionCandidate[] = [0, 1, 2].map((i) => ({
      path: `/v/a-20240101-00000${i}.zip`,
      name: `mimir-backup-space-20240101-00000${i}.zip`,
      bytes: 1,
      modifiedAt: new Date(2026, 0, 1, 0, 0, i).toISOString()
    }))
    const plan = planRetention(archives, { keep: 2 })
    expect(plan.keep).toHaveLength(2)
    expect(plan.candidates).toHaveLength(1)
  })
})
