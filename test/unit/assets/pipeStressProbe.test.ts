import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { probeEcho, assessResources, createConnectionTrace, stressProfile } from '../../../scripts/checkAssetsWindowsPipeStress.mjs'

it('连续连接定位显式区分正式压力协议，默认250ms节奏保持', () => {
  expect(stressProfile()).toEqual({ trace: false, roundDelayMs: 250, scope: 'synthetic-native-relay-only' })
  expect(stressProfile('--connection-events').roundDelayMs).toBe(250)
  expect(stressProfile('--connection-window')).toEqual({ trace: true, roundDelayMs: 0, scope: 'diagnostic-connection-window' })
  expect(() => stressProfile('--retry')).toThrow('BAD_ARGUMENTS')
})

it('连接事件有界且仅投影时刻、标识与固定错误码', () => {
  const trace = createConnectionTrace(3)
  const first = trace.begin(), second = trace.begin()
  first({ event: 'start', atMs: 1, secret: 'never log' })
  first({ event: 'connect', atMs: 2 })
  first({ event: 'close', atMs: 3 })
  second({ event: 'error', atMs: 4, code: 'ENOENT', message: 'private path' })
  expect(trace.snapshot()).toEqual([
    { clientId: 1, event: 'connect', atMs: 2, monotonicNs: null, code: null },
    { clientId: 1, event: 'close', atMs: 3, monotonicNs: null, code: null },
    { clientId: 2, event: 'error', atMs: 4, monotonicNs: null, code: 'ENOENT' }
  ])
  second({ event: 'error', atMs: 5, code: 'private path' })
  expect(trace.snapshot().at(-1)?.code).toBe('OTHER')
  expect(() => createConnectionTrace(0)).toThrow('BAD_TRACE_LIMIT')
})

it('实际socket的事件能关联失败与关闭，原失败仍拒绝', async () => {
  const trace = createConnectionTrace()
  const endpoint = await fixture(socket => socket.destroy())
  await expect(probeEcho(endpoint, Buffer.from('x'), 1000, trace.begin())).rejects.toThrow()
  const events = trace.snapshot()
  expect(events[0].event).toBe('start')
  expect(events.at(-1)?.event).toBe('close')
  expect(new Set(events.map(event => event.clientId)).size).toBe(1)
  expect(events.every(event => Number.isSafeInteger(event.atMs))).toBe(true)
  expect(events.every(event => /^\d{1,30}$/.test(event.monotonicNs))).toBe(true)
})

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
