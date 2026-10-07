import { createServer } from 'node:http'
import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { withLoopbackServer } from '../../../e2e/fixtures/withLoopbackServer'

async function assertClosed(port: number) {
  const error = await new Promise<NodeJS.ErrnoException>(resolve => {
    const socket = connect(port, '127.0.0.1')
    socket.once('error', resolve)
    socket.once('connect', () => { socket.destroy(); throw Error('server leaked') })
  })
  expect(error.code).toBe('ECONNREFUSED')
}
it('应用启动抛错仍释放已监听的模拟服务器', async () => {
  const server = createServer(), original = new Error('launch failed')
  let port = 0
  await expect(withLoopbackServer(server, async p => { port = p; throw original }, async () => {})).rejects.toBe(original)
  expect(server.listening).toBe(false); await assertClosed(port)
})
it('应用cleanup抛错仍释放模拟服务器及实际连接', async () => {
  const server = createServer(), original = new Error('cleanup failed')
  let port = 0, socket: ReturnType<typeof connect> | undefined
  await expect(withLoopbackServer(server, async p => { port = p; return { cleanup: async () => { throw original } } }, async () => {
    socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { socket!.once('connect', resolve); socket!.once('error', reject) })
    socket.on('error', () => {})
  })).rejects.toBe(original)
  expect(server.listening).toBe(false); socket?.destroy(); await assertClosed(port)
})
