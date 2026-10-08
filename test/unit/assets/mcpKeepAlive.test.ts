import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { connectAssetsBroker, encodeFrame, localEndpoint, receiveFrames, MAX_FRAME_BYTES } from '../../../electron/assets/mcp/localTransport'
import { startAssetsBroker } from '../../../electron/assets/mcp/broker'

it('真实socket闲置保活不访问业务/重连；宿主退出仍关闭，不能把正常闲置当退出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assets-keepalive-')), endpoint = localEndpoint(root)
  let pings = 0
  const server = createServer(socket => {
    socket.setTimeout(150, () => socket.destroy())
    receiveFrames(socket, MAX_FRAME_BYTES, value => {
      const v = value as any
      if (v.type === 'hello') socket.write(encodeFrame({ id: 0, ok: true, scope: { workspaceId: 'A', spaceEpoch: 'A#1' } }, MAX_FRAME_BYTES))
      else { expect(v).toEqual({ type: 'ping' }); pings++; socket.write(encodeFrame({ type: 'pong' }, MAX_FRAME_BYTES)) }
    }, () => socket.destroy())
  })
  await new Promise<void>(resolve => server.listen(endpoint, resolve))
  const client = await connectAssetsBroker({ endpoint, token: 'test', client: 'keepalive-test', keepAliveMs: 30 })
  let closed = false; void client.closed?.then(() => { closed = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(closed).toBe(false)
    expect(pings).toBeGreaterThan(2)
  } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
  expect(closed).toBe(true)
})
it('真实broker只给已认证原scope保活，无业务查询；切换终止，不重绑', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assets-ping-'))
  let epoch = 'A#1', calls = 0
  const broker = await startAssetsBroker({ endpoint: localEndpoint(root), currentScope: () => ({ workspaceId: 'A', spaceEpoch: epoch }), dispatch: async () => { calls++; return { unchanged: true } } })
  const client = await connectAssetsBroker({ ...broker, client: 'scope-heartbeat', keepAliveMs: 20 })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(calls).toBe(0)
    expect(await client.call('list_tags', {})).toEqual({ unchanged: true })
    expect(calls).toBe(1)
    epoch = 'A#2'
    await client.closed
    await expect(client.call('list_tags', {})).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(calls).toBe(1)
  } finally { await client.close(); await broker.close(); rmSync(root, { recursive: true, force: true }) }
})
