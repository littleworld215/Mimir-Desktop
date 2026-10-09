/** 合成材料的纯准备逻辑；没有模型、文件或凭据访问。 */
/** 收尾必须尝试全部步骤；保留原错误及记录/清理错误。 */
export async function finishManualApproval(steps: Array<() => void | Promise<void>>, originalError?: unknown): Promise<void> {
  const errors: unknown[] = originalError === undefined ? [] : [originalError]
  for (const step of steps) {
    try { await step() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, '人工验收或收尾失败；全部收尾步骤均已尝试')
}

export const MANUAL_MARKERS = ['[合成开头-BEGIN]', '[合成中间-MIDDLE]', '[合成末尾-END]'] as const

export function manualApprovalBody(padding = 0): string {
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 48_001) throw new Error('无效合成填充长度')
  const first = Math.floor(padding / 2)
  return `${MANUAL_MARKERS[0]}\n中文、换行与长行均为合成资料。\n${'-'.repeat(first)}${MANUAL_MARKERS[1]}\n${'-'.repeat(padding - first)}${MANUAL_MARKERS[2]}`
}

export function fitManualApprovalBody(baseDetailBytes: number, targetDetailBytes: number): string {
  if (!Number.isSafeInteger(baseDetailBytes) || baseDetailBytes <= 0 || !Number.isSafeInteger(targetDetailBytes)
    || targetDetailBytes < baseDetailBytes || targetDetailBytes > 48_001) throw new Error('无效完整弹窗字节校准')
  // ASCII无JSON转义，每个填充字符增加恰好一个字节。校准基线必须来自真实完整detail。
  return manualApprovalBody(targetDetailBytes - baseDetailBytes)
}
