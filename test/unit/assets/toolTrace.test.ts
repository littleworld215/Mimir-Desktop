import { it, expect, vi } from 'vitest'
import { withToolTrace } from '../../../electron/agent/toolTrace'
import { readApprovalSourceContext } from '../../../electron/agent/approval'
it('追踪包装保持调用配置signal/metadata、原型this与批准来源，成功失败打点不变', async () => {
  const controller = new AbortController(), config = { signal: controller.signal, metadata: { conversation: 'A' } }
  const base = { name: 'asset_ai', marker: 'base', invoke: vi.fn(async function(this: { marker: string }, _input: unknown, received: unknown) {
    expect(this.marker).toBe('base'); expect(readApprovalSourceContext()).toMatchObject({ origin: 'subagent', subagentId: 'assets' })
    return received
  }) }
  const onCall = vi.fn(), onDone = vi.fn(), onError = vi.fn()
  const traced = withToolTrace(base, { onCall, onDone, onError, source: { origin: 'subagent', subagentId: 'assets' } })
  expect(await traced.invoke({ assetId: 1 }, config)).toBe(config)
  expect(base.invoke).toHaveBeenCalledWith({ assetId: 1 }, config)
  expect(onCall).toHaveBeenCalledTimes(1); expect(onDone).toHaveBeenCalledTimes(1)
  base.invoke.mockRejectedValueOnce(Error('failed'))
  await expect(traced.invoke({}, config)).rejects.toThrow('failed')
  expect(onError).toHaveBeenCalledTimes(1)
})
