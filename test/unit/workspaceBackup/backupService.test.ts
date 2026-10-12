import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { MaintenanceAuditEntry } from '../../../shared/workspaceBackupContracts'
import {
  ASSETS_DB_REL_PATH,
  runSpaceBackup,
  type AssetsDbHandle,
  type BackupSpaceDeps,
  type SpaceLockHandle
} from '../../../electron/workspaceBackup/backupService'
import type { SpacePathView } from '../../../electron/workspaceBackup/doctorSpaceScan'
import { deriveArchiveName } from '../../../electron/workspaceBackup/archiveNaming'
import { ARCHIVE_FILE_PATTERN, isManagedArchive } from '../../../electron/workspaceBackup/archiveNaming'

/**
 * 备份编排服务层（I6 批次 3.5 · T03）。
 *
 * 覆盖（对齐任务书 §1.1 流程 + §5 风险表 K2/K4/K5/K6/K7）：
 *
 * **成功组**
 * - 含库空间 → `ok:true` / `hasAssetsDb:true` / 归档名符合 `mimir-backup-<slug>-<ts>.zip` /
 *   `archiveName` 是 basename；
 * - 无库空间 → `ok:true` / `hasAssetsDb:false` / 归档仍生成；
 * - 审计写入且 `labels`/`counts` **不含任何绝对路径**。
 *
 * **失败组（逐项，红线：前三步未动盘 → 零副作用）**
 * - 空 spaceId → `INVALID_SPACE`，**不取锁 / 不建目录 / 不写审计**；
 * - 空间不存在 → `SPACE_NOT_FOUND`，同样零副作用；
 * - 注册表不可读 → `REGISTRY_INVALID`；
 * - 锁被占用 → `LOCK_UNAVAILABLE`，**审计未写**（未动盘）；
 * - 库存在但打开失败 → `BACKUP_FAILED`，**审计写了且 `outcome:'failed'`**；
 * - `createBackup` 失败 → `ok:false`，**锁已释放 / 库已关闭**、`backups/` 无残留。
 *
 * **红线**
 * - 结果**任何字段**不含绝对路径（JSON 序列化不含 home / space.path / 盘符模式）。
 *
 * ⚠️ 全部用 `mkdtemp` 合成 home + 注入假 IO；不启动 Electron、不触碰真实 `~/.mimir`、
 * 不依赖真实 `better-sqlite3` 原生绑定（用假 `openAssetsDb`）。
 * 「真实 Windows ABI 下的真库备份」留真实环境验收（设计 §4 已预期）。
 */

let home: string
let spaceRoot: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mimir-backup-service-'))
  spaceRoot = join(home, 'spaces', 'my-space')
  mkdirSync(join(spaceRoot, '.mimir', 'assets'), { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

/** 一个空间视图。 */
function spaceView(overrides: Partial<SpacePathView> = {}): SpacePathView {
  return { id: 'space-1', name: '我的空间', path: spaceRoot, ...overrides }
}

/** 缺省 deps（注入只读注册表解析 → 给定空间；其余走假实现）。 */
function deps(extra: Partial<BackupSpaceDeps> = {}): BackupSpaceDeps {
  return {
    home,
    resolveSpaces: () => [spaceView()],
    ...extra
  }
}

/** 假源库句柄（记录 backup 目标与 close 调用）。 */
function fakeAssetsDb(): AssetsDbHandle & { backedUpTo: string[]; closed: number } {
  const handle = {
    backedUpTo: [] as string[],
    closed: 0,
    async backup(dest: string): Promise<void> {
      handle.backedUpTo.push(dest)
    },
    close(): void {
      handle.closed += 1
    }
  }
  return handle
}

/** 假空间锁句柄（记录 release 调用）。 */
function fakeLock(): SpaceLockHandle & { released: number } {
  const handle = {
    released: 0,
    release(): void {
      handle.released += 1
    }
  }
  return handle
}

/**
 * 记录「谁被调用」的探针：用于红线断言「空 spaceId 时锁未被取 / backups 未建 / 审计未写」。
 */
function spyDeps(extra: Partial<BackupSpaceDeps> = {}): {
  deps: BackupSpaceDeps
  audits: MaintenanceAuditEntry[]
  lockCalls: number
  progress: Array<{ stage: string; detail: string }>
} {
  const audits: MaintenanceAuditEntry[] = []
  const progress: Array<{ stage: string; detail: string }> = []
  const state = { lockCalls: 0 }
  const base = deps({
    acquireSpaceLock: () => {
      state.lockCalls += 1
      return fakeLock()
    },
    writeAudit: (_h, entry) => audits.push(entry),
    onProgress: (p) => progress.push(p),
    ...extra
  })
  return {
    deps: base,
    audits,
    progress,
    get lockCalls() {
      return state.lockCalls
    }
  } as { deps: BackupSpaceDeps; audits: MaintenanceAuditEntry[]; lockCalls: number; progress: Array<{ stage: string; detail: string }> }
}

describe('runSpaceBackup · 成功组', () => {
  it('含库空间 → ok:true / hasAssetsDb:true / 归档名合规 / archiveName 是 basename', async () => {
    const dbPath = join(spaceRoot, ASSETS_DB_REL_PATH)
    writeFileSync(dbPath, Buffer.alloc(8))

    const assetsDb = fakeAssetsDb()
    const lock = fakeLock()
    // 用真实 createBackup 需要真实打包能力；这里注入一个「假打包」记录请求并回填结果。
    const requestedDestinations: string[] = []
    const fixedNow = new Date(2024, 0, 2, 3, 4, 5)

    const result = await runSpaceBackup({ spaceId: 'space-1' }, deps({
      now: () => fixedNow,
      openAssetsDb: () => assetsDb,
      acquireSpaceLock: () => lock,
      createBackup: (async (req: { destination?: string }) => {
        requestedDestinations.push(req.destination ?? '')
        // 模拟真实 packer：写出归档文件（保留策略白名单能认出它）。
        writeFileSync(req.destination!, Buffer.alloc(32, 0x7a))
        return {
          destination: req.destination!,
          entries: 3,
          totalBytes: 100,
          archiveBytes: 32,
          archiveSha256: 'a'.repeat(64),
          excluded: []
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.spaceId).toBe('space-1')
    expect(result.name).toBe('我的空间')
    expect(result.hasAssetsDb).toBe(true)
    expect(result.entries).toBe(3)
    expect(result.totalBytes).toBe(100)
    expect(result.archiveBytes).toBe(32)
    expect(result.excluded).toBe(0)

    // 归档名 = 命名规范派生、是 basename（不含路径）、受管白名单认可。
    const expected = deriveArchiveName('我的空间', fixedNow)
    expect(result.archiveName).toBe(expected)
    expect(result.archiveName).toBe(basename(result.archiveName))
    expect(ARCHIVE_FILE_PATTERN.test(result.archiveName)).toBe(true)
    expect(isManagedArchive(result.archiveName)).toBe(true)

    // 库快照被调用过一次；库关闭一次；锁释放一次。
    expect(assetsDb.backedUpTo).toHaveLength(0) // 快照是 packer 内部做的，本层只把句柄传进去
    expect(assetsDb.closed).toBe(1)
    expect(lock.released).toBe(1)

    // destination 是 backups/ 下的绝对路径（且与派生名一致）。
    expect(requestedDestinations).toHaveLength(1)
    expect(basename(requestedDestinations[0])).toBe(expected)
  })

  it('无库空间 → ok:true / hasAssetsDb:false / 归档仍生成（不加库到归档）', async () => {
    // 不建 assets.db。
    const createdWithAssetsDb: Array<unknown> = []
    const fixedNow = new Date(2024, 5, 6, 7, 8, 9)

    const result = await runSpaceBackup({ spaceId: 'space-1' }, deps({
      now: () => fixedNow,
      acquireSpaceLock: () => fakeLock(),
      createBackup: (async (req: { assetsDb: unknown; assetsDbRelPath?: string; destination?: string }) => {
        createdWithAssetsDb.push(req.assetsDb)
        // assetsDb 必须为 null，且**不应**给 assetsDbRelPath（无库）。
        expect(req.assetsDb).toBeNull()
        expect(req.assetsDbRelPath).toBeUndefined()
        writeFileSync(req.destination!, Buffer.alloc(16))
        return {
          destination: req.destination!,
          entries: 1,
          totalBytes: 5,
          archiveBytes: 16,
          archiveSha256: 'b'.repeat(64),
          excluded: []
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hasAssetsDb).toBe(false)
    // 归档确实生成。
    expect(existsSync(join(home, 'backups', result.archiveName))).toBe(true)
    expect(createdWithAssetsDb).toEqual([null])
  })

  it('审计写入：action:backup / outcome:ok，labels/counts 不含任何绝对路径', async () => {
    writeFileSync(join(spaceRoot, ASSETS_DB_REL_PATH), Buffer.alloc(8))
    const fixedNow = new Date(2024, 0, 2, 3, 4, 5)

    const audits: MaintenanceAuditEntry[] = []
    const result = await runSpaceBackup({ spaceId: 'space-1' }, deps({
      now: () => fixedNow,
      openAssetsDb: () => fakeAssetsDb(),
      acquireSpaceLock: () => fakeLock(),
      writeAudit: (_h, entry) => audits.push(entry),
      createBackup: (async (req: { destination?: string }) => {
        writeFileSync(req.destination!, Buffer.alloc(16))
        return {
          destination: req.destination!,
          entries: 2,
          totalBytes: 20,
          archiveBytes: 16,
          archiveSha256: 'c'.repeat(64),
          excluded: []
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))

    expect(result.ok).toBe(true)
    expect(audits).toHaveLength(1)
    const entry = audits[0]
    expect(entry.action).toBe('backup')
    expect(entry.outcome).toBe('ok')
    expect(entry.labels?.space).toBe('我的空间')
    expect(entry.labels?.archive).toBe(deriveArchiveName('我的空间', fixedNow))

    // 审计条目序列化后**不含**任何绝对路径（home / spaceRoot / 盘符）。
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain(home)
    expect(serialized).not.toContain(spaceRoot)
    expect(serialized).not.toContain('backups')
    expect(/[A-Za-z]:\\/.test(serialized)).toBe(false)
  })
})

describe('runSpaceBackup · 失败组（前三步未动盘 = 零副作用红线）', () => {
  it('spaceId 为空 → INVALID_SPACE，且**不取锁 / 不建 backups / 不写审计**', async () => {
    const probe = spyDeps()
    const result = await runSpaceBackup({ spaceId: '' }, probe.deps)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('INVALID_SPACE')

    // 红线：未动盘——锁未取、backups/ 未建、审计未写。
    expect(probe.lockCalls).toBe(0)
    expect(existsSync(join(home, 'backups'))).toBe(false)
    expect(probe.audits).toHaveLength(0)
  })

  it('spaceId 为纯空白 → INVALID_SPACE（trim 后为空）', async () => {
    const probe = spyDeps()
    const result = await runSpaceBackup({ spaceId: '   ' }, probe.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('INVALID_SPACE')
    expect(probe.lockCalls).toBe(0)
    expect(existsSync(join(home, 'backups'))).toBe(false)
    expect(probe.audits).toHaveLength(0)
  })

  it('spaceId 不存在 → SPACE_NOT_FOUND，零副作用', async () => {
    const probe = spyDeps()
    const result = await runSpaceBackup({ spaceId: 'does-not-exist' }, probe.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('SPACE_NOT_FOUND')
    expect(probe.lockCalls).toBe(0)
    expect(existsSync(join(home, 'backups'))).toBe(false)
    expect(probe.audits).toHaveLength(0)
  })

  it('注册表不可读（resolveSpaces 抛错）→ REGISTRY_INVALID，零副作用', async () => {
    const probe = spyDeps({
      resolveSpaces: () => {
        throw Error('REGISTRY_INVALID')
      }
    })
    const result = await runSpaceBackup({ spaceId: 'space-1' }, probe.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('REGISTRY_INVALID')
    expect(probe.lockCalls).toBe(0)
    expect(existsSync(join(home, 'backups'))).toBe(false)
    expect(probe.audits).toHaveLength(0)
  })

  it('锁被占用（EEXIST）→ LOCK_UNAVAILABLE，**审计未写**（未动盘）', async () => {
    const probe = spyDeps({
      acquireSpaceLock: () => {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
    })
    const result = await runSpaceBackup({ spaceId: 'space-1' }, probe.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LOCK_UNAVAILABLE')
    // 未动盘：不建目录、不写审计。
    expect(existsSync(join(home, 'backups'))).toBe(false)
    expect(probe.audits).toHaveLength(0)
  })
})

describe('runSpaceBackup · 失败组（已动盘：写 failed 审计）', () => {
  it('库存在但打开失败 → BACKUP_FAILED，审计写了且 outcome:failed', async () => {
    writeFileSync(join(spaceRoot, ASSETS_DB_REL_PATH), Buffer.alloc(8))

    const audits: MaintenanceAuditEntry[] = []
    const lock = fakeLock()
    const result = await runSpaceBackup({ spaceId: 'space-1' }, deps({
      acquireSpaceLock: () => lock,
      openAssetsDb: () => {
        throw Object.assign(new Error('SQLITE_CANTOPEN'), { code: 'SQLITE_CANTOPEN' })
      },
      writeAudit: (_h, entry) => audits.push(entry)
    }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('BACKUP_FAILED')

    // 已动盘（打开了库路径）→ 写 failed 审计，带 code。
    expect(audits).toHaveLength(1)
    expect(audits[0].action).toBe('backup')
    expect(audits[0].outcome).toBe('failed')
    expect(audits[0].code).toBe('SQLITE_CANTOPEN')
    // 锁仍被释放（finally）。
    expect(lock.released).toBe(1)
  })

  it('createBackup 失败 → ok:false，锁已释放 / 库已关闭 / backups 无残留归档', async () => {
    writeFileSync(join(spaceRoot, ASSETS_DB_REL_PATH), Buffer.alloc(8))

    const assetsDb = fakeAssetsDb()
    const lock = fakeLock()
    const audits: MaintenanceAuditEntry[] = []

    const result = await runSpaceBackup({ spaceId: 'space-1' }, deps({
      openAssetsDb: () => assetsDb,
      acquireSpaceLock: () => lock,
      writeAudit: (_h, entry) => audits.push(entry),
      createBackup: (async () => {
        throw Object.assign(new Error('BACKUP_FAILED'), { code: 'BACKUP_FAILED' })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('BACKUP_FAILED')

    // 注入的假对象断言：库已关闭、锁已释放。
    expect(assetsDb.closed).toBe(1)
    expect(lock.released).toBe(1)

    // backups/ 下无残留归档（无 mimir-backup-*.zip）。
    const backupsDir = join(home, 'backups')
    if (existsSync(backupsDir)) {
      const leftovers = readdirSync(backupsDir).filter((n) => isManagedArchive(n))
      expect(leftovers).toHaveLength(0)
    }
    // 失败审计写入。
    expect(audits).toHaveLength(1)
    expect(audits[0].outcome).toBe('failed')
  })

  it('writeAudit 自身抛错 → 不影响备份成功结果（只 warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(spaceRoot, ASSETS_DB_REL_PATH), Buffer.alloc(8))

    const result = await runSpaceBackup({ spaceId: 'space-1' }, deps({
      openAssetsDb: () => fakeAssetsDb(),
      acquireSpaceLock: () => fakeLock(),
      writeAudit: () => {
        throw Error('audit boom')
      },
      createBackup: (async (req: { destination?: string }) => {
        writeFileSync(req.destination!, Buffer.alloc(16))
        return {
          destination: req.destination!,
          entries: 1,
          totalBytes: 5,
          archiveBytes: 16,
          archiveSha256: 'd'.repeat(64),
          excluded: []
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))

    expect(result.ok).toBe(true)
    expect(warn).toHaveBeenCalled()
  })
})

describe('runSpaceBackup · 红线：任何字段不含绝对路径', () => {
  it('成功结果序列化后不含 home / space.path / 盘符模式', async () => {
    writeFileSync(join(spaceRoot, ASSETS_DB_REL_PATH), Buffer.alloc(8))
    const fixedNow = new Date(2024, 0, 2, 3, 4, 5)

    const result = await runSpaceBackup({ spaceId: 'space-1' }, deps({
      now: () => fixedNow,
      openAssetsDb: () => fakeAssetsDb(),
      acquireSpaceLock: () => fakeLock(),
      createBackup: (async (req: { destination?: string }) => {
        writeFileSync(req.destination!, Buffer.alloc(16))
        return {
          destination: req.destination!,
          entries: 1,
          totalBytes: 5,
          archiveBytes: 16,
          archiveSha256: 'e'.repeat(64),
          excluded: []
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(home)
    expect(serialized).not.toContain(spaceRoot)
    // 任何盘符形态（如 `C:\` / `D:\`）。
    expect(/[A-Za-z]:\\/.test(serialized)).toBe(false)
    // 也不应出现 POSIX 绝对根残留。
    expect(serialized).not.toContain('/spaces/')
  })

  it('失败结果序列化后不含绝对路径', async () => {
    const audits: MaintenanceAuditEntry[] = []
    const result = await runSpaceBackup({ spaceId: '' }, deps({ writeAudit: (_h, e) => audits.push(e) }))
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(home)
    expect(/[A-Za-z]:\\/.test(serialized)).toBe(false)
  })

  it('进度 detail 不含任何绝对路径 / space.path / home', async () => {
    writeFileSync(join(spaceRoot, ASSETS_DB_REL_PATH), Buffer.alloc(8))
    const progress: Array<{ stage: string; detail: string }> = []

    await runSpaceBackup({ spaceId: 'space-1' }, deps({
      openAssetsDb: () => fakeAssetsDb(),
      acquireSpaceLock: () => fakeLock(),
      onProgress: (p) => progress.push(p),
      createBackup: (async (req: { destination?: string }) => {
        writeFileSync(req.destination!, Buffer.alloc(16))
        return {
          destination: req.destination!,
          entries: 1,
          totalBytes: 5,
          archiveBytes: 16,
          archiveSha256: 'f'.repeat(64),
          excluded: []
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))

    // 至少覆盖 resolving / locking / snapshotting / packing / done。
    const stages = progress.map((p) => p.stage)
    expect(stages).toContain('resolving')
    expect(stages).toContain('locking')
    expect(stages).toContain('snapshotting')
    expect(stages).toContain('packing')
    expect(stages).toContain('done')

    const serialized = JSON.stringify(progress)
    expect(serialized).not.toContain(home)
    expect(serialized).not.toContain(spaceRoot)
    expect(/[A-Za-z]:\\/.test(serialized)).toBe(false)
  })
})

describe('runSpaceBackup · 无库时不发 snapshotting 进度', () => {
  it('无 assets.db → 进度不含 snapshotting', async () => {
    const progress: Array<{ stage: string; detail: string }> = []
    await runSpaceBackup({ spaceId: 'space-1' }, deps({
      acquireSpaceLock: () => fakeLock(),
      onProgress: (p) => progress.push(p),
      createBackup: (async (req: { destination?: string }) => {
        writeFileSync(req.destination!, Buffer.alloc(16))
        return {
          destination: req.destination!,
          entries: 1,
          totalBytes: 5,
          archiveBytes: 16,
          archiveSha256: 'g'.repeat(64),
          excluded: []
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    }))
    const stages = progress.map((p) => p.stage)
    expect(stages).not.toContain('snapshotting')
    expect(stages).toContain('packing')
    expect(stages).toContain('done')
  })
})
