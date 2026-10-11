import { describe, expect, it } from 'vitest'

import {
  planRetention,
  type RetentionCandidate,
  type RetentionPolicy
} from '../../../electron/workspaceBackup/retentionPolicy'

/**
 * 归档保留策略纯函数（I6 批次 5 · T01）。
 *
 * 覆盖：21 份 → 留最新 20、候选 1（最早）；恰好 20 → 零候选；19 → 零候选；`keepDays` 生效；
 * 排序正确；**纯函数零副作用**（入参数组深度比较前后一致）。
 */

const POLICY: RetentionPolicy = { keep: 20 }

/** 造 N 份候选：`at(i)` 的 i 越大越新（mock 用连续分钟，保证排序唯一）。 */
function makeArchives(count: number): RetentionCandidate[] {
  const out: RetentionCandidate[] = []
  // 基准时刻：2024-01-01T00:00:00 本地。
  const base = new Date(2024, 0, 1, 0, 0, 0).getTime()
  for (let i = 0; i < count; i += 1) {
    const at = new Date(base + i * 60 * 1000) // 每分钟一份，i 越大越新
    out.push({
      path: `C:/backups/mimir-backup-space-${String(i).padStart(2, '0')}.zip`,
      name: `mimir-backup-space-${String(i).padStart(2, '0')}.zip`,
      bytes: 1000 + i,
      modifiedAt: at.toISOString()
    })
  }
  return out
}

describe('planRetention · keep 份数', () => {
  it('21 份 → 保留最新 20、候选 1（最早那份）', () => {
    const archives = makeArchives(21)
    const plan = planRetention(archives, POLICY)

    expect(plan.keep).toHaveLength(20)
    expect(plan.candidates).toHaveLength(1)
    // 候选 = 最早那份（索引 0），字节 = 1000。
    expect(plan.candidates[0].name).toBe('mimir-backup-space-00.zip')
    expect(plan.candidates[0].reason).toBe('beyond-keep')
    expect(plan.reclaimableBytes).toBe(1000)
    // keep 全为 recent。
    expect(plan.keep.every((k) => k.reason === 'recent')).toBe(true)
  })

  it('恰好 20 份 → 零候选', () => {
    const plan = planRetention(makeArchives(20), POLICY)
    expect(plan.keep).toHaveLength(20)
    expect(plan.candidates).toHaveLength(0)
    expect(plan.reclaimableBytes).toBe(0)
  })

  it('19 份 → 零候选（未超限）', () => {
    const plan = planRetention(makeArchives(19), POLICY)
    expect(plan.keep).toHaveLength(19)
    expect(plan.candidates).toHaveLength(0)
    expect(plan.reclaimableBytes).toBe(0)
  })

  it('25 份 → 候选 5（最早的 5 份），可释放字节合计正确', () => {
    const plan = planRetention(makeArchives(25), POLICY)
    expect(plan.keep).toHaveLength(20)
    expect(plan.candidates).toHaveLength(5)
    // 最早 5 份 = 索引 0..4，字节 1000+1001+1002+1003+1004 = 5010。
    expect(plan.reclaimableBytes).toBe(5010)
    expect(plan.candidates.map((c) => c.name)).toEqual([
      'mimir-backup-space-04.zip',
      'mimir-backup-space-03.zip',
      'mimir-backup-space-02.zip',
      'mimir-backup-space-01.zip',
      'mimir-backup-space-00.zip'
    ])
  })
})

describe('planRetention · 排序', () => {
  it('乱序输入 → 输出按 modifiedAt 降序（最新在前）', () => {
    const archives = makeArchives(3)
    // 打乱：倒序传入。
    const shuffled = [archives[2], archives[0], archives[1]]
    const plan = planRetention(shuffled, { keep: 2 })

    expect(plan.keep.map((k) => k.name)).toEqual([
      'mimir-backup-space-02.zip',
      'mimir-backup-space-01.zip'
    ])
    expect(plan.candidates.map((c) => c.name)).toEqual(['mimir-backup-space-00.zip'])
  })

  it('candidates 末尾即最早的一份（先删最早）', () => {
    const plan = planRetention(makeArchives(22), POLICY)
    expect(plan.candidates).toHaveLength(2)
    // 降序 → 末尾为最早（索引 0）。
    expect(plan.candidates[plan.candidates.length - 1].name).toBe('mimir-backup-space-00.zip')
  })
})

describe('planRetention · keepDays 保护窗口', () => {
  it('keepDays > 0 且未超天数 → 保留（reason=within-days）', () => {
    const archives = makeArchives(3)
    // now = 最新一份 + 30 分钟；keepDays = 1 → 全部在窗口内。
    const now = new Date(new Date(archives[2].modifiedAt).getTime() + 30 * 60 * 1000)
    const plan = planRetention(archives, { keep: 1, keepDays: 1 }, now)

    expect(plan.candidates).toHaveLength(0)
    expect(plan.keep).toHaveLength(3)
    expect(plan.keep.filter((k) => k.reason === 'recent')).toHaveLength(1)
    expect(plan.keep.filter((k) => k.reason === 'within-days')).toHaveLength(2)
  })

  it('keepDays > 0 但已超天数 → 候选', () => {
    const archives = makeArchives(3)
    // now = 最新一份 + 10 天；keepDays = 1 → 只有最新 1 份靠 keep 保住，其余超窗。
    const now = new Date(new Date(archives[2].modifiedAt).getTime() + 10 * 24 * 60 * 60 * 1000)
    const plan = planRetention(archives, { keep: 1, keepDays: 1 }, now)

    expect(plan.keep).toHaveLength(1)
    expect(plan.keep[0].reason).toBe('recent')
    expect(plan.candidates).toHaveLength(2)
  })

  it('keepDays = 0 → 不启用窗口（仅按份数）', () => {
    const archives = makeArchives(3)
    const now = new Date(new Date(archives[2].modifiedAt).getTime() + 30 * 60 * 1000)
    const plan = planRetention(archives, { keep: 1, keepDays: 0 }, now)
    expect(plan.keep).toHaveLength(1)
    expect(plan.candidates).toHaveLength(2)
  })
})

describe('planRetention · 纯函数零副作用', () => {
  it('入参数组与元素对象均未被修改（深比较前后一致）', () => {
    const archives = makeArchives(21)
    // 深拷贝快照（用 JSON，结构为纯数据）。
    const before = JSON.parse(JSON.stringify(archives))

    const plan = planRetention(archives, POLICY)

    // 入参逐字未变。
    expect(archives).toEqual(before)
    // 入参数组长度不变（未被 sort 原地改动？sort 会改；这里断言内容等同且长度不变）。
    expect(archives).toHaveLength(21)
    // 返回结构独立于入参（改返回不影响入参）。
    expect(plan.keep).not.toBe(archives)
  })

  it('返回元素是副本（改副本不回流到入参）', () => {
    const archives = makeArchives(3)
    const plan = planRetention(archives, { keep: 2 })
    // 修改返回元素的 bytes，入参应不变。
    ;(plan.keep[0] as { bytes: number }).bytes = 999999
    expect(archives.find((a) => a.name === plan.keep[0].name)?.bytes).not.toBe(999999)
  })
})
