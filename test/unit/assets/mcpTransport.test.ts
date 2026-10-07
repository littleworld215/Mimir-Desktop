import { connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startAssetsBroker } from '../../../electron/assets/mcp/broker'
import { BrokerError, connectAssetsBroker, localEndpoint } from '../../../electron/assets/mcp/localTransport'

let root: string
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mimir-mcp-')) })
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; rmSync(root, { recursive: true, force: true }) })
const scope = { workspaceId: 'space-A', spaceEpoch: 'A#1' }
async function fixture(overrides: Partial<Parameters<typeof startAssetsBroker>[0]> = {}) {
  const dispatch = vi.fn(async () => ({ text: '原文\r\n\n' }))
  const broker = await startAssetsBroker({ endpoint: localEndpoint(root), currentScope: () => scope, dispatch, ...overrides })
  cleanups.push(broker.close)
  const client = await connectAssetsBroker({ endpoint: broker.endpoint, token: broker.token, client: '测试客户端' })
  cleanups.push(client.close)
  return { broker, client, dispatch }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

it('真实本机连接：认证绑定空间、原文空白保留，不允许请求自己指定空间', async () => {
  const { client, dispatch } = await fixture()
  expect(client.scope).toEqual(scope)
  expect(await client.call('get_asset', { assetCode: 'note' })).toEqual({ text: '原文\r\n\n' })
  expect(dispatch.mock.calls[0][0]).toMatchObject({ scope, client: '测试客户端', method: 'get_asset' })
  await expect(client.call('get_asset', { workspaceId: 'B' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('无应用返回APP_NOT_RUNNING；错误token认证失败，不能读取或泄露凭据', async () => {
  await expect(connectAssetsBroker({ endpoint: localEndpoint(root), token: 'x'.repeat(43), client: 'x' })).rejects.toMatchObject({ code: 'APP_NOT_RUNNING' })
  const { broker, dispatch } = await fixture()
  await expect(connectAssetsBroker({ endpoint: broker.endpoint, token: 'x'.repeat(43), client: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect(dispatch).not.toHaveBeenCalled()
})

it('写入默认拒绝；confirm不是批准替代，读工具不申请批准', async () => {
  const { client, dispatch } = await fixture()
  await expect(client.call('create_asset', { confirm: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
  await expect(client.call('create_asset', { confirm: true })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' })
  expect(dispatch).not.toHaveBeenCalled()
  await client.call('list_categories', {})
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('写入独立批准带外部来源/冻结空间，拒绝零业务调用，批准才提交', async () => {
  const approve = vi.fn(async () => false)
  const { client, dispatch } = await fixture({ approve })
  await expect(client.call('add_tags', { assetCode: 'a', tags: ['科研'], confirm: true })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' })
  expect(approve.mock.calls[0][0]).toMatchObject({ client: '测试客户端', scope, method: 'add_tags' })
  expect(dispatch).not.toHaveBeenCalled()
  approve.mockResolvedValue(true)
  await client.call('add_tags', { assetCode: 'a', tags: ['科研'], confirm: true })
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('批准等待期间切空间：SPACE_CHANGED且零写入', async () => {
  let current = scope
  const gate = deferred<boolean>()
  const entered = deferred<void>()
  const { client, dispatch } = await fixture({ currentScope: () => current, approve: async () => { entered.resolve(); return gate.promise } })
  const result = client.call('update_metadata', { assetCode: 'a', baseVersion: 1, confirm: true }).catch(e => e)
  await entered.promise
  current = { workspaceId: 'B', spaceEpoch: 'B#2' }; gate.resolve(true)
  expect(await result).toMatchObject({ code: 'SPACE_CHANGED' })
  expect(dispatch).not.toHaveBeenCalled()
})

it('断连取消批准，晚批准不进入服务', async () => {
  const gate = deferred<boolean>(), entered = deferred<void>()
  let signal!: AbortSignal
  const { client, dispatch } = await fixture({ approve: async r => { signal = r.signal; entered.resolve(); return gate.promise } })
  const result = client.call('create_asset', { confirm: true }).catch(e => e)
  await entered.promise; await client.close()
  expect(await result).toMatchObject({ code: 'DISCONNECTED' })
  await vi.waitFor(() => expect(signal.aborted).toBe(true))
  gate.resolve(true); await new Promise(r => setTimeout(r, 10))
  expect(dispatch).not.toHaveBeenCalled()
})

it('批准截止及时结束，忽略signal的晚批准仍零写入', async () => {
  const gate = deferred<boolean>()
  const { client, dispatch } = await fixture({ timeoutMs: 30, approve: async () => gate.promise })
  await expect(client.call('save_ai_draft', { confirm: true })).rejects.toMatchObject({ code: 'TIMEOUT' })
  gate.resolve(true); await new Promise(r => setTimeout(r, 10))
  expect(dispatch).not.toHaveBeenCalled()
})

it('白名单拒绝SQL/模型/文件路径；参数禁止作用域与凭据', async () => {
  const { client, dispatch } = await fixture()
  for (const method of ['sql', 'generateAiDraft', 'importFile']) await expect(client.call(method, {})).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })
  for (const args of [{ path: 'C:/secret' }, { apiKey: 'secret' }, { spaceEpoch: 'B' }]) await expect(client.call('get_asset', args)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  expect(dispatch).not.toHaveBeenCalled()
})

it('服务异常脱敏、结果尺寸有界、未知错误不能泄露本机路径或key', async () => {
  const dispatch = vi.fn(async () => { throw new Error('C:/secret apiKey=secret') })
  const { client } = await fixture({ dispatch, maxBytes: 1024 })
  await expect(client.call('get_asset', {})).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: '资产请求失败。' })
  dispatch.mockImplementation(async () => ({ text: 'x'.repeat(2048) }) as never)
  await expect(client.call('get_asset', {})).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
})

it('超长原始帧在认证前断开，不执行服务；关闭broker拒绝在途请求', async () => {
  const entered = deferred<void>()
  let signal!: AbortSignal
  const { broker, client, dispatch } = await fixture({ maxBytes: 1024, dispatch: async r => { signal = r.signal; entered.resolve(); return new Promise(() => {}) } })
  const socket = connect(broker.endpoint)
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => socket.write('x'.repeat(2048))); socket.once('error', reject); socket.once('close', () => resolve()) })
  const result = client.call('get_asset', {}).catch(e => e)
  await entered.promise; await broker.close()
  expect(await result).toMatchObject({ code: 'DISCONNECTED' })
  expect(signal.aborted).toBe(true)
  expect(dispatch).not.toHaveBeenCalled()
})

it('远程pipe/TCP端点被拒绝；本机endpoint每次不同', async () => {
  expect(localEndpoint(root)).not.toBe(localEndpoint(root))
  for (const endpoint of ['\\\\remote\\pipe\\mimir', 'tcp://127.0.0.1:1234', 'relative.sock']) {
    await expect(startAssetsBroker({ endpoint, currentScope: () => scope, dispatch: async () => ({}) })).rejects.toMatchObject({ code: 'BAD_ENDPOINT' })
  }
})

it('客户端超大请求本地拒绝后不消耗序号，连接仍可处理下一请求', async () => {
  const { client, dispatch } = await fixture()
  await expect(client.call('get_asset', { text: 'x'.repeat(1024 * 1024) })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  expect(await client.call('get_asset', {})).toEqual({ text: '原文\r\n\n' })
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('同一连接的并发调用默认BUSY，不伪造第二次批准', async () => {
  const entered = deferred<void>(), gate = deferred<boolean>()
  const approve = vi.fn(async () => { entered.resolve(); return gate.promise })
  const { client, dispatch } = await fixture({ approve })
  const first = client.call('add_reference', { confirm: true })
  await entered.promise
  await expect(client.call('create_asset', { confirm: true })).rejects.toMatchObject({ code: 'BUSY' })
  expect(approve).toHaveBeenCalledTimes(1)
  gate.resolve(true); await first
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('同一原始数据内错误握手是终态，不能继续正确握手后调用服务', async () => {
  const { broker, dispatch } = await fixture()
  const socket = connect(broker.endpoint)
  socket.on('error', () => {})
  await new Promise<void>(resolve => {
    socket.on('data', () => {})
    socket.once('close', resolve)
    socket.once('connect', () => socket.write([
      { type: 'hello', token: 'bad', client: 'x' },
      { type: 'hello', token: broker.token, client: 'x' },
      { id: 1, method: 'get_asset', args: {} }
    ].map(v => JSON.stringify(v) + '\n').join('')))
  })
  expect(dispatch).not.toHaveBeenCalled()
})

it('错误对象可变message不能将宿主路径或密钥透传给客户端', async () => {
  const error = new BrokerError('BAD_REQUEST')
  error.message = 'C:/secret apiKey=secret'
  const { client } = await fixture({ dispatch: async () => { throw error } })
  await expect(client.call('get_asset', {})).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '请求格式非法。' })
  // 客户端本来也不信任消息；这里检查实际管道输出，而非仅检查客户端本地错误。
  const { broker } = await fixture({ dispatch: async () => { throw error } })
  const socket = connect(broker.endpoint)
  const raw = await new Promise<string>(resolve => {
    let text = '', ready = false
    socket.on('error', () => {})
    socket.on('data', data => {
      text += data.toString()
      if (!ready) { ready = true; socket.write(JSON.stringify({ id: 1, method: 'get_asset', args: {} }) + '\n') }
      else { socket.destroy(); resolve(text) }
    })
    socket.once('connect', () => socket.write(JSON.stringify({ type: 'hello', token: broker.token, client: 'x' }) + '\n'))
  })
  expect(raw).not.toContain('secret')
  expect(raw).toContain('请求格式非法。')
})

it('原始并发BUSY使批准终止，对端半开输入下晚批准也零服务调用', async () => {
  const entered = deferred<void>(), gate = deferred<boolean>()
  const { broker, dispatch } = await fixture({ approve: async () => { entered.resolve(); return gate.promise } })
  const socket = connect({ path: broker.endpoint, allowHalfOpen: true })
  let reply = '', ready = false
  socket.on('error', () => {})
  socket.on('data', data => {
    reply += data.toString()
    if (!ready) { ready = true; socket.write(JSON.stringify({ id: 1, method: 'create_asset', args: { confirm: true } }) + '\n') }
  })
  socket.once('connect', () => socket.write(JSON.stringify({ type: 'hello', token: broker.token, client: 'x' }) + '\n'))
  await entered.promise
  socket.write(JSON.stringify({ id: 2, method: 'get_asset', args: {} }) + '\n')
  await vi.waitFor(() => expect(reply).toContain('BUSY'))
  gate.resolve(true); await new Promise(r => setTimeout(r, 20))
  socket.destroy()
  expect(dispatch).not.toHaveBeenCalled()
})
