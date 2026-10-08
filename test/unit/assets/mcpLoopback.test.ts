import { createConnection, type Socket } from 'node:net'
import { expect, it } from 'vitest'
import { startAssetsLoopbackBroker } from '../../../electron/assets/mcp/broker'
import { encodeFrame, receiveFrames, MAX_FRAME_BYTES } from '../../../electron/assets/mcp/localTransport'

function wire(port: number) {
  const socket = createConnection({ host: '127.0.0.1', port })
  const messages: any[] = [], waiters: ((v:any) => void)[] = []
  receiveFrames(socket, MAX_FRAME_BYTES, v => { const next = waiters.shift(); if (next) next(v); else messages.push(v) }, () => socket.destroy())
  return { socket, send: (v:unknown) => socket.write(encodeFrame(v)), next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise<any>(r => waiters.push(r)) }
}
it('内部临时端口仍认证、冻结scope、确认批准，不给CLI增加TCP端点', async () => {
  let epoch = 'A#1', dispatches = 0
  const broker = await startAssetsLoopbackBroker({ currentScope: () => ({ workspaceId: 'A', spaceEpoch: epoch }), dispatch: async () => ++dispatches })
  const clients: Socket[] = []
  try {
    expect(broker.port).toBeGreaterThan(0)
    for (const token of ['', 'bad-token', broker.token]) {
      const c = wire(broker.port); clients.push(c.socket)
      c.send({ type: 'hello', token, client: '测试' })
      expect((await c.next()).ok).toBe(token === broker.token)
      if (token !== broker.token) continue
      expect(c.socket.remoteAddress).toBe('127.0.0.1')
      c.send({ id: 1, method: 'create_asset', args: {} })
      expect((await c.next()).code).toBe('CONFIRM_REQUIRED')
      c.send({ id: 2, method: 'create_asset', args: {confirm: true} })
      expect((await c.next()).code).toBe('APPROVAL_DENIED')
      expect(dispatches).toBe(0)
      c.send({ id: 3, method: 'list_tags', args: {} })
      expect((await c.next()).ok).toBe(true)
      epoch = 'A#2'
      c.send({ id: 4, method: 'list_tags', args: {} })
      expect((await c.next()).code).toBe('SPACE_CHANGED')
      expect(dispatches).toBe(1)
    }
  } finally { for (const s of clients) s.destroy(); await broker.close() }
})
it('无认证字节在5秒内被关闭且零dispatch；幂等关闭回收所有已认证连接', async () => {
  let dispatches = 0
  const broker = await startAssetsLoopbackBroker({currentScope: () => ({workspaceId: 'A', spaceEpoch: 'A#1'}), dispatch: async () => ++dispatches})
  const idle = createConnection({host:'127.0.0.1', port:broker.port})
  const start = Date.now()
  try {
    await new Promise<void>((r, e) => { idle.once('close', () => r()); idle.once('error', e) })
    expect(Date.now() - start).toBeLessThan(6000)
    expect(dispatches).toBe(0)
    const client = wire(broker.port)
    client.send({type:'hello', token:broker.token, client:'关闭探针'})
    expect((await client.next()).ok).toBe(true)
    const ended = new Promise<void>(r => client.socket.once('close', () => r()))
    await Promise.all([broker.close(), broker.close()]); await ended
  } finally { idle.destroy(); await broker.close() }
})
