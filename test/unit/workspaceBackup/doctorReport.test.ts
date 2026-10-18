/**
 * `doctorReport.ts` 单测（I6 批次 4 · T02）。
 *
 * 覆盖设计稿 §6 `doctorReport.test.ts` 一行：
 * - **全绿组**：合成 home + 无归档 + 无残留 → 全 `ok`（允许全绿就是全绿，对齐 §1.3）。
 * - **逐项降级组**：注入会让某一份归档 `verifyArchive` 抛错的假实现 → 该项 `warning`，
 *   但**其它维照常出结论**（K4：一份失败绝不吞掉整份报告）。
 * - **C1 抛错 → `error`**，且报告仍含其它检查项（C2/C3/C4）。
 * - **detail 不含绝对路径**：注入含 `D:\secret\path` 的场景，断言最终 detail 无该串（redact 后只剩 basename）。
 * - **C4 发现残留暂存根 → `notice`**。
 * - **断言只读**：跑完 `buildDoctorReport` 后，合成 home 目录**没有新增任何文件**（前后快照对比）。
 *
 * ⚠️ 沙箱限制：不触碰真实 `~/.mimir`；一律 `mkdtemp` 合成 home。所有 IO 依赖均注入假实现，
 *   以便在无 Electron ABI 的 vitest node 环境下稳定运行。
 */

import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildDoctorReport, summarize, type DoctorDeps } from '../../../electron/workspaceBackup/doctorReport'

/** 递归快照一个目录树（相对路径 → 类型），用于「只读：无新文件」断言。 */
function snapshotTree(root: string): Map<string, 'file' | 'directory'> {
  const out = new Map<string, 'file' | 'directory'>()
  const walk = (dir: string, prefix: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        out.set(rel, 'directory')
        walk(join(dir, entry.name), rel)
      } else {
        out.set(rel, 'file')
      }
    }
  }
  walk(root, '')
  return out
}

const createdHomes: string[] = []
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'mimir-doctor-'))
  createdHomes.push(home)
  return home
}

afterEach(() => {
  while (createdHomes.length > 0) {
    const home = createdHomes.pop()
    if (home) rmSync(home, { recursive: true, force: true })
  }
})

/** 全绿基线 deps：无空间、无归档、无残留；所有 IO 注入假实现。 */
function greenDeps(home: string): DoctorDeps {
  return {
    home,
    readRegistry: () => [],
    listArchives: async () => [],
    verifyArchive: async () => ({}),
    checkSpaceIntegrity: async () => undefined,
    resolveSpaces: () => [],
    scanResiduals: async () => []
  }
}

describe('buildDoctorReport · 全绿组', () => {
  it('无归档无残留无空间 → 全 ok', async () => {
    const home = makeHome()
    const report = await buildDoctorReport(greenDeps(home))

    expect(report.checks.map((check) => check.id)).toEqual([
      'REGISTRY_READABLE',
      'ARCHIVE_VERIFY',
      'SPACE_INTEGRITY',
      'RESIDUAL_ARTIFACTS'
    ])
    expect(report.checks.every((check) => check.severity === 'ok')).toBe(true)
    expect(report.summary).toEqual({ ok: 4, notice: 0, warning: 0, error: 0 })
    expect(typeof report.at).toBe('string')
  })

  it('summary 与逐项 severity 计数一致（依赖 T01 summarize）', async () => {
    const home = makeHome()
    const report = await buildDoctorReport(greenDeps(home))
    expect(report.summary).toEqual(summarize(report.checks))
  })

  it('进度回调被调用且 detail 不含路径', async () => {
    const home = makeHome()
    const details: string[] = []
    await buildDoctorReport({
      ...greenDeps(home),
      onProgress: (p) => details.push(p.detail)
    })
    expect(details.length).toBeGreaterThanOrEqual(4)
    for (const detail of details) {
      expect(detail).not.toContain(home)
      expect(detail).not.toContain('\\')
      expect(detail).not.toContain('/')
    }
  })
})

describe('buildDoctorReport · 逐项降级组（单份失败不吞报告）', () => {
  it('一份归档验包抛错 → 该项 warning，其余维照常出结论', async () => {
    const home = makeHome()
    const report = await buildDoctorReport({
      ...greenDeps(home),
      listArchives: async () => [
        { path: join(home, 'backups', 'good.zip'), name: 'good.zip' },
        { path: join(home, 'backups', 'bad.zip'), name: 'bad.zip' }
      ],
      // 第二份（bad.zip）抛错，第一份通过。
      verifyArchive: async (path: string) => {
        if (path.endsWith('bad.zip')) {
          const error = new Error('boom') as Error & { code: string }
          error.code = 'SHA256_MISMATCH'
          throw error
        }
        return {}
      }
    })

    const archive = report.checks.find((check) => check.id === 'ARCHIVE_VERIFY')
    expect(archive?.severity).toBe('warning')
    expect(archive?.detail).toContain('bad.zip')
    expect(archive?.detail).toContain('SHA256_MISMATCH')
    expect(archive?.facts).toEqual({ total: 2, verified: 1, failed: 1 })

    // 其余三维照常出结论（未被吞掉）。
    expect(report.checks.find((check) => check.id === 'REGISTRY_READABLE')?.severity).toBe('ok')
    expect(report.checks.find((check) => check.id === 'SPACE_INTEGRITY')?.severity).toBe('ok')
    expect(report.checks.find((check) => check.id === 'RESIDUAL_ARTIFACTS')?.severity).toBe('ok')
    expect(report.summary).toEqual({ ok: 3, notice: 0, warning: 1, error: 0 })
  })

  it('单个空间资产库校验抛错 → 该项 warning，记录空间名（非路径）', async () => {
    const home = makeHome()
    const report = await buildDoctorReport({
      ...greenDeps(home),
      readRegistry: () => [{ id: 's1', name: '空间甲' }, { id: 's2', name: '空间乙' }],
      resolveSpaces: () => [
        { id: 's1', name: '空间甲', path: join(home, 'spaces', 'alpha') },
        { id: 's2', name: '空间乙', path: join(home, 'spaces', 'beta') }
      ],
      checkSpaceIntegrity: async (dbPath: string) => {
        if (dbPath.includes('beta')) {
          const error = new Error('integrity') as Error & { code: string }
          error.code = 'INTEGRITY_FAILED'
          throw error
        }
      }
    })

    const space = report.checks.find((check) => check.id === 'SPACE_INTEGRITY')
    expect(space?.severity).toBe('warning')
    expect(space?.detail).toContain('空间乙')
    expect(space?.detail).toContain('INTEGRITY_FAILED')
    // 记录的是「名」，不是路径。
    expect(space?.detail).not.toContain(home)
    expect(space?.detail).not.toContain('spaces')
  })
})

describe('buildDoctorReport · C1 注册表不可读', () => {
  it('readRegistry 抛错 → C1 error，报告仍含其它检查项', async () => {
    const home = makeHome()
    const report = await buildDoctorReport({
      ...greenDeps(home),
      readRegistry: () => {
        throw new Error('REGISTRY_INVALID')
      }
    })

    const registry = report.checks.find((check) => check.id === 'REGISTRY_READABLE')
    expect(registry?.severity).toBe('error')

    // C3 因注册表不可读而降级 notice，并明示跳过原因。
    const space = report.checks.find((check) => check.id === 'SPACE_INTEGRITY')
    expect(space?.severity).toBe('notice')
    expect(space?.detail).toContain('注册表不可读')

    // 其它维（C2/C4）仍出结论。
    expect(report.checks.some((check) => check.id === 'ARCHIVE_VERIFY')).toBe(true)
    expect(report.checks.some((check) => check.id === 'RESIDUAL_ARTIFACTS')).toBe(true)
    expect(report.summary.error).toBe(1)
    expect(report.checks).toHaveLength(4)
  })

  it('空间路径解析失败（条目非法）→ C3 降级 notice（绝不 loadStore）', async () => {
    const home = makeHome()
    const report = await buildDoctorReport({
      ...greenDeps(home),
      readRegistry: () => [{ id: 's1', name: '空间甲' }],
      resolveSpaces: () => {
        throw new Error('REGISTRY_INVALID')
      }
    })
    const space = report.checks.find((check) => check.id === 'SPACE_INTEGRITY')
    expect(space?.severity).toBe('notice')
    expect(space?.detail).toContain('无法定位')
  })
})

describe('buildDoctorReport · C4 残留暂存根', () => {
  it('发现残留暂存根 → notice，只报数量与基名', async () => {
    const home = makeHome()
    const report = await buildDoctorReport({
      ...greenDeps(home),
      scanResiduals: async () => ['.mimir-restore-staging-abc', '.mimir-restore-staging-def']
    })
    const residual = report.checks.find((check) => check.id === 'RESIDUAL_ARTIFACTS')
    expect(residual?.severity).toBe('notice')
    expect(residual?.detail).toContain('2')
    expect(residual?.detail).toContain('.mimir-restore-staging-abc')
    expect(residual?.facts).toEqual({ found: 2 })
    expect(report.summary.notice).toBe(1)
  })
})

describe('buildDoctorReport · 脱敏红线（detail 不含绝对路径）', () => {
  it('注入含 D:\\secret\\path 的场景 → 最终 detail 无该串，只剩 basename', async () => {
    const home = makeHome()
    const report = await buildDoctorReport({
      ...greenDeps(home),
      // 归档名被恶意塞进一个 Windows 绝对路径。
      listArchives: async () => [{ path: 'D:\\secret\\path\\leak.zip', name: 'D:\\secret\\path\\leak.zip' }],
      verifyArchive: async () => {
        const error = new Error('x') as Error & { code: string }
        error.code = 'OPEN_FAILED'
        throw error
      },
      // 空间名被恶意塞进一个 POSIX 绝对路径。
      readRegistry: () => [{ id: 's1', name: '/home/secret/space' }],
      resolveSpaces: () => [{ id: 's1', name: '/home/secret/space', path: '/home/secret/space' }],
      checkSpaceIntegrity: async () => {
        const error = new Error('y') as Error & { code: string }
        error.code = 'INTEGRITY_FAILED'
        throw error
      }
    })

    for (const check of report.checks) {
      expect(check.detail).not.toContain('D:\\secret\\path')
      expect(check.detail).not.toContain('D:\\secret')
      expect(check.detail).not.toContain('/home/secret')
      expect(check.detail).not.toContain('secret')
    }
    // 只剩基名（proof：leak.zip 出现，父目录消失）。
    const archive = report.checks.find((check) => check.id === 'ARCHIVE_VERIFY')
    expect(archive?.detail).toContain('leak.zip')
  })
})

describe('buildDoctorReport · 只读红线（无新文件）', () => {
  it('跑完自检后，合成 home 目录没有新增任何文件', async () => {
    const home = makeHome()
    // 预置一个 .mimir/store.json（非法内容也 OK——用注入假实现，不真读它）。
    mkdirSync(join(home, '.mimir'), { recursive: true })
    writeFileSync(join(home, '.mimir', 'store.json'), '{}', 'utf8')

    const before = snapshotTree(home)
    await buildDoctorReport({
      home,
      readRegistry: () => [],
      listArchives: async () => [],
      verifyArchive: async () => ({}),
      checkSpaceIntegrity: async () => undefined,
      resolveSpaces: () => [],
      scanResiduals: async () => []
    })
    const after = snapshotTree(home)

    expect(after).toEqual(before)
    // 显式断言没有任何新增 key。
    for (const key of after.keys()) {
      expect(before.has(key)).toBe(true)
    }
  })
})

it('I9：对每个已登记空间输出只读研究检查，含未使用空间且不泄露正文或路径', async () => {
  const home = makeHome(), root = join(home, 'space')
  mkdirSync(root)
  const report = await buildDoctorReport({ ...greenDeps(home), readRegistry: () => [{ id: 's', name: '合成空间' }], resolveSpaces: () => [{ id: 's', name: '合成空间', path: root }] })
  expect(report.checks.filter(c => c.id === 'RESEARCH_INTEGRITY')).toHaveLength(1)
  const research = report.checks.find(c => c.id === 'RESEARCH_INTEGRITY')!
  expect(research.severity).toBe('notice')
  expect(research.detail).toContain('未找到研究组织文件')
  expect(research.facts).toMatchObject({ questions: 0, packs: 0, unresolved: 0 })
  expect(research.detail).not.toContain(root)
})

it('I9：引用仍在但证据文件缺失，doctor明确显示文件原因而非泛化断链', async () => {
  const { document } = await import('../libraryResearch/fixtures')
  const home = makeHome(), root = join(home, 'research-space')
  mkdirSync(join(root, '.mimir/library'), { recursive: true })
  writeFileSync(join(root, '.mimir/library/research.json'), JSON.stringify(document()))
  const report = await buildDoctorReport({ ...greenDeps(home), readRegistry: () => [{ id: 'r', name: '研究空间' }], resolveSpaces: () => [{ id: 'r', name: '研究空间', path: root }] })
  const check = report.checks.find(c => c.id === 'RESEARCH_INTEGRITY')!
  expect(check.severity).toBe('warning')
  expect(check.detail).toContain('证据文件缺失')
  expect(check.detail).toContain('EVIDENCE_MISSING')
})
