import { expect, it } from 'vitest'
import { createExternalApproval } from '../../../electron/assets/mcp/approval'
import type { BrokerRequest } from '../../../electron/assets/mcp/broker'

const request = (signal = new AbortController().signal): BrokerRequest => ({ client: '本机客户端', scope: { workspaceId: 'A', spaceEpoch: 'A#1' }, method: 'create_asset', args: { name: '文本', content: ' 第一行\r\n\n', categoryCode: 'inbox', confirm: true }, signal })
it('原生独立确认默认拒绝；完整显示JSON，不记住批准，仅明确第二按钮放行', async () => {
  let response = 0, options: any
  const window = { isDestroyed: () => false }
  const approve = createExternalApproval({ window: () => window, currentScope: () => request().scope, show: async (parent, o) => { expect(parent).toBe(window); options = o; return { response } } })
  expect(await approve(request())).toBe(false)
  expect(options).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['拒绝', '允许这一次'], noLink: true })
  expect(options.checkboxLabel).toBeUndefined()
  expect(options.detail).toContain(JSON.stringify(request().args, null, 2))
  response = 1
  expect(await approve(request())).toBe(true)
})
it('没有窗口、异常、取消、空间切换或超长完整正文均拒绝', async () => {
  let scope = request().scope, calls = 0
  const window = { isDestroyed: () => false }
  const approve = createExternalApproval({ window: () => window, currentScope: () => scope, show: async () => { calls++; scope = { workspaceId: 'B', spaceEpoch: 'B#1' }; return { response: 1 } } })
  expect(await approve(request())).toBe(false)
  expect(calls).toBe(1)
  scope = request().scope
  expect(await approve({ ...request(), args: { ...request().args, content: '字'.repeat(20000) } })).toBe(false)
  expect(calls).toBe(1)
  const controller = new AbortController(); controller.abort()
  expect(await approve(request(controller.signal))).toBe(false)
  const denied = createExternalApproval({ window: () => null, currentScope: () => scope, show: async () => { throw Error('不该打开') } })
  expect(await denied(request())).toBe(false)
  const throws = createExternalApproval({ window: () => window, currentScope: () => scope, show: async () => { throw Error('secret') } })
  expect(await throws(request())).toBe(false)
})
it('非法字段、无confirm及只读工具不打开批准窗口；客户端自报名按不可信文本展示', async () => {
  let calls = 0
  const approve = createExternalApproval({ window: () => ({ isDestroyed: () => false }), currentScope: () => request().scope, show: async (_, options) => { calls++; expect(options.detail).toContain('客户端自报'); return { response: 1 } } })
  expect(await approve({ ...request(), args: { ...request().args, apiKey: 'secret' } })).toBe(false)
  expect(await approve({ ...request(), args: { ...request().args, confirm: false } })).toBe(false)
  expect(await approve({ ...request(), method: 'list_tags', args: {} })).toBe(false)
  expect(calls).toBe(0)
  expect(await approve(request())).toBe(true)
})
it('只允许一个确认窗口；切换空间自动取消，晚点击允许不生效', async () => {
  let scope = request().scope, finish!: (v: { response: number }) => void, signal!: AbortSignal
  const approve = createExternalApproval({ window: () => ({ isDestroyed: () => false }), currentScope: () => scope, show: async (_, o) => { signal = o.signal!; return new Promise(resolve => { finish = resolve }) } })
  const first = approve(request())
  expect(await approve(request())).toBe(false)
  scope = { workspaceId: 'B', spaceEpoch: 'B#1' }
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(signal.aborted).toBe(true)
  finish({ response: 1 })
  expect(await first).toBe(false)
})
it('采纳草稿必须显示完整已存正文，不能只凭draftId盲批', async () => {
  const r = { ...request(), method: 'adopt_ai_draft' as const, args: { draftId: 1, confirm: true } }
  let calls = 0
  const base = { window: () => ({ isDestroyed: () => false }), currentScope: () => r.scope, show: async (_: any, o: any) => { calls++; return { response: o.detail.includes('草稿完整正文') ? 1 : 0 } } }
  expect(await createExternalApproval(base)(r)).toBe(false)
  expect(calls).toBe(0)
  expect(await createExternalApproval({ ...base, preview: async () => ({ content: '草稿完整正文' }) })(r)).toBe(true)
})
