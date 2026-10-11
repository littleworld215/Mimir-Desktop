/**
 * `auditWriter.ts` 单测（I6 批次 4 · T03）。
 *
 * 覆盖设计稿 §6 `auditWriter.test.ts` 一行：按天分片命名；追加不覆盖；`logs/` 自动建；
 * 写失败仅 warn 不抛；**正文/凭据零落盘**（红线断言）。全部用 `mkdtemp` 合成 home，
 * 绝不写真实 `~/.mimir`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendMaintenanceAudit, maintenanceAuditPath } from '../../../electron/workspaceBackup/auditWriter'
import { readRecentMaintenanceAudit } from '../../../electron/workspaceBackup/auditReader'
import type { MaintenanceAuditEntry } from '../../../shared/workspaceBackupContracts'

/** 合成一个临时 home（每个用例独立，绝不碰真实 `~/.mimir`）。 */
function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'mimir-audit-writer-'))
}

/** 一条正常审计条目。 */
function entry(overrides: Partial<MaintenanceAuditEntry> = {}): MaintenanceAuditEntry {
  return {
    at: '2025-01-02T03:04:05.000Z',
    action: 'restore',
    outcome: 'ok',
    ...overrides
  }
}

describe('maintenanceAuditPath · 按天分片命名', () => {
  it('落点为 <home>/.mimir/logs/maintenance-audit-<YYYY-MM-DD>.jsonl', () => {
    const home = makeHome()
    try {
      const path = maintenanceAuditPath(home, new Date(2025, 0, 2)) // 本地 2025-01-02
      expect(path).toBe(join(home, '.mimir', 'logs', 'maintenance-audit-2025-01-02.jsonl'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('不同日期 → 不同分片文件', () => {
    const home = makeHome()
    try {
      const a = maintenanceAuditPath(home, new Date(2025, 0, 2))
      const b = maintenanceAuditPath(home, new Date(2025, 0, 3))
      expect(a).not.toBe(b)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('appendMaintenanceAudit · 追加语义', () => {
  it('目录不存在时自动建 logs/ 并写入一行', () => {
    const home = makeHome()
    try {
      appendMaintenanceAudit(home, entry({ action: 'doctor', outcome: 'ok' }))
      const path = maintenanceAuditPath(home, new Date())
      expect(existsSync(path)).toBe(true)
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ action: 'doctor', outcome: 'ok' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('追加不覆盖：写两条 → 文件有两行（顺序一致）', () => {
    const home = makeHome()
    try {
      appendMaintenanceAudit(home, entry({ at: '2025-01-02T00:00:00.000Z', outcome: 'ok' }))
      appendMaintenanceAudit(home, entry({ at: '2025-01-02T01:00:00.000Z', outcome: 'failed' }))
      const path = maintenanceAuditPath(home, new Date())
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).outcome).toBe('ok')
      expect(JSON.parse(lines[1]).outcome).toBe('failed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('appendMaintenanceAudit · 失败仅 warn 不抛（S-A3 / K6）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('home 指向一个文件路径 → 建目录失败 → 不抛、仅 warn', () => {
    const base = makeHome()
    try {
      // 把 home 指向一个**已存在的普通文件**：其下的 `.mimir/logs` 无法创建（ENOTDIR）。
      const bogusHome = join(base, 'not-a-dir')
      writeFileSync(bogusHome, 'x')
      expect(() => appendMaintenanceAudit(bogusHome, entry())).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()
      const args = warnSpy.mock.calls[0]
      expect(String(args[0])).toContain('[maintenance-audit]')
      // 只报错误码，不报本机路径（warn 日志本身也不该泄漏路径）。
      const detail = args[1] as { code?: unknown }
      expect(JSON.stringify(detail)).not.toContain(bogusHome)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('序列化失败（BigInt）也不抛、仅 warn', () => {
    const home = makeHome()
    try {
      // JSON.stringify 遇 BigInt 会抛 TypeError —— 验证兜底 try/catch 包住了「写盘前」的整段。
      const bad = { ...entry(), counts: { n: 1n } } as unknown as MaintenanceAuditEntry
      expect(() => appendMaintenanceAudit(home, bad)).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('appendMaintenanceAudit · 正文/凭据零落盘（红线断言）', () => {
  it('labels 里的绝对路径被 basename 化、counts 里的敏感键被剔除', () => {
    const home = makeHome()
    try {
      // 强行 as any 注入类型不允许的字段，验证 writer 的兜底脱敏确实生效。
      const dirty = {
        at: '2025-01-02T03:04:05.000Z',
        action: 'restore',
        outcome: 'ok',
        counts: { entries: 3, apiKey: 999 },
        labels: { space: '我的空间', file: 'D:\\secret\\a.pdf' }
      } as unknown as MaintenanceAuditEntry

      appendMaintenanceAudit(home, dirty)

      const raw = readFileSync(maintenanceAuditPath(home, new Date()), 'utf8')
      // 红线：不得含本机绝对路径、不得含疑似凭据键。
      expect(raw).not.toContain('D:\\secret')
      expect(raw).not.toContain('apiKey')
      // 正常信息保留（证明不是「整条被清空」的假绿）。
      expect(raw).toContain('a.pdf')
      expect(raw).toContain('我的空间')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('读回的条目里也不含 D:\\secret、不含疑似 key', () => {
    const home = makeHome()
    try {
      const dirty = {
        at: '2025-01-02T03:04:05.000Z',
        action: 'restore',
        outcome: 'ok',
        counts: { apiKey: 999 },
        labels: { file: 'D:\\secret\\a.pdf' }
      } as unknown as MaintenanceAuditEntry
      appendMaintenanceAudit(home, dirty)

      const view = readRecentMaintenanceAudit(home, 10)
      const serialized = JSON.stringify(view)
      expect(serialized).not.toContain('D:\\secret')
      expect(serialized).not.toContain('apiKey')
      expect(view.entries).toHaveLength(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('appendMaintenanceAudit · 半行容错（跨 writer/reader）', () => {
  it('手动写一行坏 JSON + 一行好 JSON → reader 只读出好的那条并计数', () => {
    const home = makeHome()
    try {
      const path = maintenanceAuditPath(home, new Date())
      // 先经 writer 建立目录，再手工追加「坏行 + 好行」。
      appendMaintenanceAudit(home, entry({ outcome: 'ok' }))
      const good = JSON.stringify(entry({ at: '2025-01-02T09:00:00.000Z', outcome: 'failed' }))
      const bad = '{"at":"2025-01-02T08:00:00.000Z","action":"rest' // 半行截断
      writeFileSync(path, `${readFileSync(path, 'utf8')}${bad}\n${good}\n`)

      const view = readRecentMaintenanceAudit(home, 10)
      expect(view.entries).toHaveLength(2)
      expect(view.skipped).toBe(1)
      expect(view.entries.some((e) => e.outcome === 'failed')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
