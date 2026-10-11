import { describe, expect, it } from 'vitest'

import {
  ARCHIVE_FILE_PATTERN,
  archiveTimestamp,
  deriveArchiveName,
  isManagedArchive
} from '../../../electron/workspaceBackup/archiveNaming'

/**
 * 归档命名规范（I6 批次 5 · T01）。
 *
 * 覆盖：
 * - slug 化边界（空名 / 中文 / 超长 / 特殊字符 / 连续 `-`）；
 * - `deriveArchiveName` 与 `ARCHIVE_FILE_PATTERN` **互逆**；
 * - `isManagedArchive` 对 `.partial` / 快照名 / 非本应用文件名**一律 false**。
 */

describe('deriveArchiveName · slug 化边界', () => {
  it('普通英文名 → 小写 + 连字符', () => {
    const name = deriveArchiveName('My Space', new Date(2024, 0, 2, 3, 4, 5))
    expect(name).toBe('mimir-backup-my-space-20240102-030405.zip')
    expect(isManagedArchive(name)).toBe(true)
  })

  it('空名 → slug 兜底为 space', () => {
    const name = deriveArchiveName('', new Date(2024, 0, 2, 3, 4, 5))
    expect(name).toBe('mimir-backup-space-20240102-030405.zip')
    expect(isManagedArchive(name)).toBe(true)
  })

  it('全特殊字符名 → slug 兜底为 space', () => {
    const name = deriveArchiveName('!!!###', new Date(2024, 0, 2, 3, 4, 5))
    expect(name).toBe('mimir-backup-space-20240102-030405.zip')
    expect(isManagedArchive(name)).toBe(true)
  })

  it('中文名 → 非 [a-z0-9] 折为 -（全中文 → 兜底 space）', () => {
    const name = deriveArchiveName('科研', new Date(2024, 0, 2, 3, 4, 5))
    expect(name).toBe('mimir-backup-space-20240102-030405.zip')
  })

  it('中英混排 → 保留英文片段', () => {
    const name = deriveArchiveName('abc 科研 xyz', new Date(2024, 0, 2, 3, 4, 5))
    expect(name).toBe('mimir-backup-abc-xyz-20240102-030405.zip')
  })

  it('连续分隔符被压缩、首尾 - 被去除', () => {
    const name = deriveArchiveName('  --Hello___World--  ', new Date(2024, 0, 2, 3, 4, 5))
    expect(name).toBe('mimir-backup-hello-world-20240102-030405.zip')
  })

  it('超长名裁到 64 字符', () => {
    const long = 'a'.repeat(200)
    const name = deriveArchiveName(long, new Date(2024, 0, 2, 3, 4, 5))
    const slug = ARCHIVE_FILE_PATTERN.exec(name)?.[1] ?? ''
    expect(slug.length).toBe(64)
    expect(isManagedArchive(name)).toBe(true)
  })

  it('裁剪恰好切在分隔符上时 → 尾部 - 被去除（仍 ≤64）', () => {
    const name = deriveArchiveName(`${'a'.repeat(63)}-tail`, new Date(2024, 0, 2, 3, 4, 5))
    const slug = ARCHIVE_FILE_PATTERN.exec(name)?.[1] ?? ''
    expect(slug).toBe('a'.repeat(63))
    expect(isManagedArchive(name)).toBe(true)
  })
})

describe('deriveArchiveName ↔ ARCHIVE_FILE_PATTERN 互逆', () => {
  const cases: Array<[string, Date]> = [
    ['My Space', new Date(2024, 0, 2, 3, 4, 5)],
    ['', new Date(1999, 11, 31, 23, 59, 59)],
    ['科研工作台', new Date(2025, 5, 15, 0, 0, 0)],
    ['a'.repeat(100), new Date(2024, 6, 4, 12, 30, 45)]
  ]

  for (const [spaceName, at] of cases) {
    it(`isManagedArchive(deriveArchiveName(${JSON.stringify(spaceName)}, …)) === true`, () => {
      expect(isManagedArchive(deriveArchiveName(spaceName, at))).toBe(true)
    })

    it(`archiveTimestamp(deriveArchiveName(…)) 还原到同一分钟`, () => {
      const parsed = archiveTimestamp(deriveArchiveName(spaceName, at))
      expect(parsed).not.toBeNull()
      const got = parsed as Date
      expect(got.getFullYear()).toBe(at.getFullYear())
      expect(got.getMonth()).toBe(at.getMonth())
      expect(got.getDate()).toBe(at.getDate())
      expect(got.getHours()).toBe(at.getHours())
      expect(got.getMinutes()).toBe(at.getMinutes())
      expect(got.getSeconds()).toBe(at.getSeconds())
    })
  }
})

describe('isManagedArchive · 非本应用产物一律 false', () => {
  const rejected = [
    'backup-3f2a1b4c-0000-4000-8000-000000000000.zip.partial', // 打包中暂存名（UUID）
    'backup-3f2a1b4c-0000-4000-8000-000000000000.zip',
    'store.json.pre-restore-2024-01-02T03-04-05.000Z-ab12cd.bak',
    'schema-1-20240102-030405-3f2a1b4c.db',
    'foo.zip',
    'mimir-backup-20240102-030405.zip', // 缺 slug 段
    'mimir-backup-my-space.zip', // 缺时间戳
    'mimir-backup-my-space-20240102-030405.tar',
    'mimir-backup-my-space-20240102-030405.zip.bak', // 尾部锚点外
    'xmimir-backup-my-space-20240102-030405.zip', // 头部锚点外
    'mimir-backup-My-Space-20240102-030405.zip' // 大写 slug 不合法
  ]

  for (const name of rejected) {
    it(`拒绝：${name}`, () => {
      expect(isManagedArchive(name)).toBe(false)
    })
  }

  it('.partial 判定为 false（变异验证锚点）', () => {
    expect(isManagedArchive('backup-3f2a1b4c-0000-4000-8000-000000000000.zip.partial')).toBe(false)
  })
})

describe('archiveTimestamp · 解析失败 / 非法日期', () => {
  it('非匹配名 → null', () => {
    expect(archiveTimestamp('foo.zip')).toBeNull()
  })

  it('非法日期（月/日溢出）→ null（不静默滚动）', () => {
    expect(archiveTimestamp('mimir-backup-x-20241340-030405.zip')).toBeNull()
  })

  it('合法名 → 正确本地时刻', () => {
    const parsed = archiveTimestamp('mimir-backup-x-20240102-030405.zip')
    expect(parsed).not.toBeNull()
    const got = parsed as Date
    expect(got.getFullYear()).toBe(2024)
    expect(got.getMonth()).toBe(0)
    expect(got.getDate()).toBe(2)
    expect(got.getHours()).toBe(3)
    expect(got.getMinutes()).toBe(4)
    expect(got.getSeconds()).toBe(5)
  })
})
