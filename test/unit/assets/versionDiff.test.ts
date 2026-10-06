import { describe, expect, it } from 'vitest'
import { compareVersionText, DIFF_CELL_BUDGET, DIFF_LINE_BUDGET } from '../../../electron/assets/versionDiff'

function reconstruct(result: ReturnType<typeof compareVersionText>, side: 'before' | 'after'): string {
  if (result.mode === 'originals') return side === 'before' ? result.beforeText! : result.afterText!
  return result.lines.filter(line => line.kind === 'context' || line.kind === (side === 'before' ? 'remove' : 'add'))
    .map(line => line.text).join('\n')
}

describe('有预算且可完整重建的版本比较', () => {
  it.each([
    ['', ''], ['', '\n'], ['a\n', 'a\n\n'],
    ['a\r\nb\r\n', 'a\r\nc\r\n'],
    ['same\nsame\nold\nsame', 'same\nnew\nsame\nsame'],
    ['中文\n\t x ', '中文\n\t y ']
  ])('逐字重建输入：%j → %j', (before, after) => {
    const result = compareVersionText(before, after)
    expect(reconstruct(result, 'before')).toBe(before)
    expect(reconstruct(result, 'after')).toBe(after)
  })

  it('预算内使用逐行 LCS，稳定保留共同内容', () => {
    expect(compareVersionText('a\nold\nz', 'a\nnew\nz')).toMatchObject({
      mode: 'lcs', lines: [
        { kind: 'context', text: 'a' }, { kind: 'remove', text: 'old' },
        { kind: 'add', text: 'new' }, { kind: 'context', text: 'z' }
      ]
    })
  })

  it('超过矩阵预算退化为完整线性替换，绝不截断', () => {
    const n = Math.ceil(Math.sqrt(DIFF_CELL_BUDGET)) + 1
    const before = Array.from({ length: n }, (_, i) => `old-${i}`).join('\n')
    const after = Array.from({ length: n }, (_, i) => `new-${i}`).join('\n')
    const result = compareVersionText(before, after)
    expect(result.mode).toBe('replacement')
    expect(result.lines.length).toBe(n * 2)
    expect(reconstruct(result, 'before')).toBe(before)
    expect(reconstruct(result, 'after')).toBe(after)
  })

  it('20,000 × 20,000 行返回两份完整原文，不分配四亿格或四万行对象', () => {
    const before = Array.from({ length: 20000 }, (_, i) => `old-${i}`).join('\n')
    const after = Array.from({ length: 20000 }, (_, i) => `new-${i}`).join('\n')
    const started = performance.now()
    const result = compareVersionText(before, after)
    expect(result.mode).toBe('originals')
    expect(result.lines).toEqual([])
    expect(reconstruct(result, 'before')).toBe(before)
    expect(reconstruct(result, 'after')).toBe(after)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('极端空行正文仍原样保留，返回对象数有明确上限', () => {
    const before = '\n'.repeat(DIFF_LINE_BUDGET * 2)
    const after = before + '\r\n'
    const result = compareVersionText(before, after)
    expect(result.mode).toBe('originals')
    expect(result.beforeText).toBe(before)
    expect(result.afterText).toBe(after)
    expect(result.lines).toHaveLength(0)
  })
})
