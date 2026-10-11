/**
 * `auditReader.ts` 单测（I6 批次 4 · T03）。
 *
 * 覆盖设计稿 §6 `auditReader.test.ts` 一行：读最近 N 条并倒序；文件不存在 → 空；
 * 坏行跳过计数；`limit` 边界（0 / 超总数）。全部用 `mkdtemp` 合成 home。
 */

import { describe, expect, it } from 'vitest'

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRecentMaintenanceAudit } from '../../../electron/workspaceBackup/auditReader'
import type { MaintenanceAuditEntry } from '../../../shared/workspaceBackupContracts'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'mimir-audit-reader-'))
}

/** 直接往 `<home>/.mimir/logs/<file>` 写内容（建目录，模拟 writer 已落盘）。 */
function writeShard(home: string, file: string, content: string): void {
  const dir = join(home, '.mimir', 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content)
}

function line(at: string, outcome: 'ok' | 'failed' = 'ok'): string {
  const entry: MaintenanceAuditEntry = { at, action: 'restore', outcome }
  return `${JSON.stringify(entry)}\n`
}

describe('readRecentMaintenanceAudit · 基本读取', () => {
  it('文件不存在 → 空视图、skipped=0、不建目录', () => {
    const home = makeHome()
    try {
      const view = readRecentMaintenanceAudit(home, 10)
      expect(view).toEqual({ entries: [], skipped: 0 })
      // 读路径绝不建目录。
      expect(() => readRecentMaintenanceAudit(home, 10)).not.toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('单分片内按写入顺序倒序返回（新的在前）', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T01:00:00.000Z') + line('2025-01-02T02:00:00.000Z') + line('2025-01-02T03:00:00.000Z'))
      const view = readRecentMaintenanceAudit(home, 10)
      expect(view.entries.map((e) => e.at)).toEqual([
        '2025-01-02T03:00:00.000Z',
        '2025-01-02T02:00:00.000Z',
        '2025-01-02T01:00:00.000Z'
      ])
      expect(view.skipped).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('跨天分片：按文件名日期倒序读取（新分片优先）', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-01.jsonl', line('2025-01-01T10:00:00.000Z'))
      writeShard(home, 'maintenance-audit-2025-01-03.jsonl', line('2025-01-03T10:00:00.000Z'))
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T10:00:00.000Z'))
      const view = readRecentMaintenanceAudit(home, 10)
      expect(view.entries.map((e) => e.at)).toEqual([
        '2025-01-03T10:00:00.000Z',
        '2025-01-02T10:00:00.000Z',
        '2025-01-01T10:00:00.000Z'
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('非审计分片文件被忽略（不误读 backup-prune-*.jsonl）', () => {
    const home = makeHome()
    try {
      writeShard(home, 'backup-prune-2025-01-02.jsonl', line('2025-01-02T09:00:00.000Z'))
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T01:00:00.000Z'))
      const view = readRecentMaintenanceAudit(home, 10)
      expect(view.entries).toHaveLength(1)
      expect(view.entries[0].at).toBe('2025-01-02T01:00:00.000Z')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('readRecentMaintenanceAudit · 坏行容错（K8）', () => {
  it('坏行（半行截断 / 非 JSON / 顶层非对象）跳过并计数，好行照读', () => {
    const home = makeHome()
    try {
      const content =
        line('2025-01-02T01:00:00.000Z') +
        '{"at":"2025-01-02T02:00:00.000Z","action":"rest' + // 半行截断
        '\n' +
        '[1,2,3]\n' + // 顶层数组 → 坏行
        line('2025-01-02T04:00:00.000Z')
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', content)
      const view = readRecentMaintenanceAudit(home, 10)
      expect(view.entries).toHaveLength(2)
      expect(view.skipped).toBe(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('文件末尾换行产生的空行不算坏行', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T01:00:00.000Z'))
      const view = readRecentMaintenanceAudit(home, 10)
      expect(view.entries).toHaveLength(1)
      expect(view.skipped).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('readRecentMaintenanceAudit · limit 边界', () => {
  it('limit=0 → 空视图', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T01:00:00.000Z'))
      expect(readRecentMaintenanceAudit(home, 0)).toEqual({ entries: [], skipped: 0 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('limit 超总数 → 全返回（不报错）', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T01:00:00.000Z') + line('2025-01-02T02:00:00.000Z'))
      const view = readRecentMaintenanceAudit(home, 999)
      expect(view.entries).toHaveLength(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('limit=2 → 只取最新的 2 条（跨分片累计）', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-01.jsonl', line('2025-01-01T10:00:00.000Z') + line('2025-01-01T11:00:00.000Z'))
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T10:00:00.000Z') + line('2025-01-02T11:00:00.000Z'))
      const view = readRecentMaintenanceAudit(home, 2)
      expect(view.entries.map((e) => e.at)).toEqual([
        '2025-01-02T11:00:00.000Z',
        '2025-01-02T10:00:00.000Z'
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('负数 / NaN limit → 空视图（不崩溃）', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T01:00:00.000Z'))
      expect(readRecentMaintenanceAudit(home, -5)).toEqual({ entries: [], skipped: 0 })
      expect(readRecentMaintenanceAudit(home, Number.NaN)).toEqual({ entries: [], skipped: 0 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('readRecentMaintenanceAudit · 读取侧兜底脱敏', () => {
  it('人为写入含绝对路径的脏行 → 读回已脱敏', () => {
    const home = makeHome()
    try {
      const dirty: MaintenanceAuditEntry = {
        at: '2025-01-02T01:00:00.000Z',
        action: 'restore',
        outcome: 'ok',
        labels: { file: 'D:\\secret\\a.pdf' }
      }
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', `${JSON.stringify(dirty)}\n`)
      const view = readRecentMaintenanceAudit(home, 10)
      const serialized = JSON.stringify(view)
      expect(serialized).not.toContain('D:\\secret')
      expect(view.entries[0].labels?.file).toBe('a.pdf')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('readRecentMaintenanceAudit · 不暴露文件路径', () => {
  it('返回结构只有 entries / skipped（无 path 字段）', () => {
    const home = makeHome()
    try {
      writeShard(home, 'maintenance-audit-2025-01-02.jsonl', line('2025-01-02T01:00:00.000Z'))
      const view = readRecentMaintenanceAudit(home, 10)
      expect(Object.keys(view).sort()).toEqual(['entries', 'skipped'])
      expect(JSON.stringify(view)).not.toContain(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
