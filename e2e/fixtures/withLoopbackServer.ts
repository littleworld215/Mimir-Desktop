import type { Server } from 'node:http'
import type { Socket } from 'node:net'

/** 将启动也纳入finally；应用cleanup故障不能跳过模拟服务和连接的释放。 */
export async function withLoopbackServer<T extends { cleanup: () => Promise<void> }, R>(
  server: Server, launch: (port: number) => Promise<T>, run: (app: T) => Promise<R>
): Promise<R> {
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
  server.on('connection', track)
  let app: T | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', failed); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('模拟服务器没有本机端口。')
    app = await launch(address.port)
    return await run(app)
  } finally {
    try { await app?.cleanup() } finally {
      server.removeListener('connection', track)
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}
