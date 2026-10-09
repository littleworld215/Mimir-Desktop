import { expect, it } from 'vitest'
import { createExternalApproval, MAX_APPROVAL_BYTES } from '../../../electron/assets/mcp/approval'
import type { BrokerRequest } from '../../../electron/assets/mcp/broker'
import { finishManualApproval, fitManualApprovalBody, manualApprovalBody, MANUAL_MARKERS } from '../../../e2e/helpers/manualApprovalPlan'

it('记录失败和连接关闭失败仍尝试应用清理及最终记录，并保留原错误', async () => {
  const original = Error('request failed'), disk = Error('disk full'), close = Error('close failed')
  const attempted: string[] = []
  const result = finishManualApproval([
    () => { attempted.push('save'); throw disk },
    () => { attempted.push('close'); throw close },
    () => { attempted.push('cleanup') },
    () => { attempted.push('final-save') }
  ], original).catch(error => error)
  const error = await result
  expect(attempted).toEqual(['save', 'close', 'cleanup', 'final-save'])
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors).toEqual([original, disk, close])
})

it('根据实际完整弹窗字节校准中文多行合成正文，48000可显示、48001拒绝且不截断', async () => {
  const details: string[] = []
  const scope = { workspaceId: '人工临时空间', spaceEpoch: 'temporary#1' }
  const approve = createExternalApproval({ window: () => ({ isDestroyed: () => false }), currentScope: () => scope,
    show: async (_, options) => { details.push(options.detail!); return { response: 0 } } })
  const request: BrokerRequest = { client: '人工原生验收', scope, method: 'create_asset',
    args: { name: '合成资料', categoryCode: 'inbox', content: manualApprovalBody(), confirm: true }, signal: new AbortController().signal }
  await approve(request)
  const baseBytes = Buffer.byteLength(details[0], 'utf8')
  const atLimit = fitManualApprovalBody(baseBytes, MAX_APPROVAL_BYTES)
  await approve({ ...request, args: { ...request.args, content: atLimit } })
  expect(Buffer.byteLength(details[1], 'utf8')).toBe(48_000)
  for (const marker of MANUAL_MARKERS) expect(details[1]).toContain(marker)
  await approve({ ...request, args: { ...request.args, content: fitManualApprovalBody(baseBytes, MAX_APPROVAL_BYTES + 1) } })
  expect(details).toHaveLength(2)
})

it('无效校准、倒退目标或过大分配在启动人工请求前拒绝', () => {
  for (const [base, target] of [[0, 1000], [1.5, 1000], [NaN, 1000], [1000, 999], [1000, 48002], [1000, Infinity]]) {
    expect(() => fitManualApprovalBody(base, target)).toThrow()
  }
})

it('填充只增加JSON的ASCII字节，开头/中间/末尾标记及中文换行保持完整', () => {
  const base = manualApprovalBody()
  const padded = fitManualApprovalBody(700, 1701)
  expect(Buffer.byteLength(JSON.stringify(padded)) - Buffer.byteLength(JSON.stringify(base))).toBe(1001)
  expect(padded.startsWith(MANUAL_MARKERS[0])).toBe(true)
  expect(padded.endsWith(MANUAL_MARKERS[2])).toBe(true)
  expect(padded.indexOf(MANUAL_MARKERS[1])).toBeGreaterThan(400)
  expect(padded).toContain('中文、换行与长行')
})
