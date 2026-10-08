import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { probeEcho, assessResources } from '../../../scripts/checkAssetsWindowsPipeStress.mjs'

const servers: Server[] = [], sockets = new Set<Socket>()
async function fixture(handle: (socket: Socket) => void) {
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    handle(socket)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { host: '127.0.0.1', port: (server.address() as { port: number }).port }
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

it('压力探针对分片回显逐字核对并释放每轮socket', async () => {
  const endpoint = await fixture(socket => socket.on('data', data => {
    socket.write(data.subarray(0, 7))
    socket.write(data.subarray(7))
  }))
  const payload = Buffer.alloc(262144)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251
  await expect(probeEcho(endpoint, payload, 2000)).resolves.toBe(payload.length)
})

it('字节损坏不是吞吐成功，提前断开不是完成', async () => {
  const corrupt = await fixture(socket => socket.on('data', data => { data[0] ^= 1; socket.write(data) }))
  await expect(probeEcho(corrupt, Buffer.from('完整数据'), 1000)).rejects.toThrow('ECHO_MISMATCH')
  const partial = await fixture(socket => socket.once('data', data => socket.end(data.subarray(0, 1))))
  await expect(probeEcho(partial, Buffer.from('完整数据'), 1000)).rejects.toThrow('ECHO_INCOMPLETE')
})

it('静默流有截止期限且主动关闭连接', async () => {
  const endpoint = await fixture(() => {})
  const started = Date.now()
  await expect(probeEcho(endpoint, Buffer.from('silent'), 60)).rejects.toThrow('ECHO_TIMEOUT')
  expect(Date.now() - started).toBeLessThan(1000)
})

it('资源闸门不能把持续句柄或私有内存增长写成PASS', () => {
  const baseline = { handles: 100, privateBytes: 32 * 1024 * 1024, workingSet: 40 * 1024 * 1024 }
  expect(assessResources(baseline, { ...baseline, handles: 140 }).pass).toBe(false)
  expect(assessResources(baseline, { ...baseline, privateBytes: 100 * 1024 * 1024 }).pass).toBe(false)
  expect(assessResources(baseline, { ...baseline, handles: 103 }).pass).toBe(true)
  expect(() => assessResources(baseline, { ...baseline, handles: NaN })).toThrow('BAD_METRICS')
})
