import type { VersionDiffLine } from '../../shared/assetsContracts'

/** 上限包含矩阵边界；总矩阵最多约 2 MiB，避免按正文行数乘积巨量分配。 */
export const DIFF_CELL_BUDGET = 500000
/** 限制跨 IPC 的行对象数量；超限返回完整前后原文，而不是截断行。 */
export const DIFF_LINE_BUDGET = 20000

export interface VersionTextComparison {
  mode: 'lcs' | 'replacement' | 'originals'
  lines: VersionDiffLine[]
  beforeText?: string
  afterText?: string
}

function boundedLineCount(text: string): number {
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++count > DIFF_LINE_BUDGET) return count
  }
  return count
}

/** 空白、CRLF、末尾换行均保留；每种返回模式都能逐字重建两侧正文。 */
export function compareVersionText(before: string, after: string): VersionTextComparison {
  if (boundedLineCount(before) + boundedLineCount(after) > DIFF_LINE_BUDGET) {
    return { mode: 'originals', lines: [], beforeText: before, afterText: after }
  }
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  if ((n + 1) * (m + 1) > DIFF_CELL_BUDGET) {
    return {
      mode: 'replacement',
      lines: [...a.map(text => ({ kind: 'remove' as const, text })), ...b.map(text => ({ kind: 'add' as const, text }))]
    }
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: VersionDiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'context', text: a[i++] })
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: 'remove', text: a[i++] })
    } else {
      lines.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < n) lines.push({ kind: 'remove', text: a[i++] })
  while (j < m) lines.push({ kind: 'add', text: b[j++] })
  return { mode: 'lcs', lines }
}
