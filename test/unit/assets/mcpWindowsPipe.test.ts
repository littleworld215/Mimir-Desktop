import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishDiagnosticHelper } from '../../../scripts/lib/assetsPipeDiagnostics.mjs'
import { startWindowsPipeRelay, type PipeAudit } from '../../../electron/assets/mcp/windowsPipeRelay'
import { probeEcho } from '../../../scripts/checkAssetsWindowsPipeStress.mjs'

const WINDOWS_PIPE_SOURCE = readFileSync('native/assets-pipe-helper/AssetsNativePipe.cs', 'utf8')
const artifact = { kind: 'development' as const, appRoot: process.cwd() }

it.runIf(process.platform === 'win32')('原生交接在启动Relay前已创建并审计下一活实例', async () => {
  // Test-only observation guard. It never creates, reorders, waits for or retries an instance.
  function replaceOnce(source: string, from: string, to: string) {
    expect(source.split(from)).toHaveLength(2)
    return source.replace(from, to)
  }
  let source = replaceOnce(WINDOWS_PIPE_SOURCE, '  static void Observe(Task task) { }',
    '  static readonly Dictionary<NamedPipeServerStream,int> testOrdinals = new Dictionary<NamedPipeServerStream,int>();\n  static int testLatestOrdinal;\n  static NamedPipeServerStream testLatestPipe;\n  static void Observe(Task task) { }')
  source = replaceOnce(source, '        return pipe;', '        testOrdinals.Add(pipe, ordinal); testLatestOrdinal = ordinal; testLatestPipe = pipe;\n        return pipe;')
  source = replaceOnce(source, '          var task = Relay(pipe, port, stop.Token);',
    '          if (testLatestOrdinal <= testOrdinals[pipe] || testLatestPipe.SafePipeHandle.IsClosed) { Emit("{\\"kind\\":\\"handoff-missing\\"}"); throw new IOException(); }\n          var task = Relay(pipe, port, stop.Token);')
  const sockets = new Set<Socket>()
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.pipe(socket) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const name = endpoint(), kinds: string[] = []
  const diagnostic = await publishDiagnosticHelper(source)
  const child = spawn(diagnostic.executable, [], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, MIMIR_PIPE_ENDPOINT: name, MIMIR_PIPE_PORT: String((server.address() as { port: number }).port) }
  })
  child.stderr.resume(); child.stdin.on('error', () => {})
  let buffer = '', echoError: unknown, exitCode: number | null = null
  const closed = new Promise<void>(resolve => child.once('close', code => { exitCode = code; resolve() }))
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GUARD_READY_TIMEOUT')), 15000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', () => { clearTimeout(timer); reject(new Error('GUARD_START_FAILED')) })
      child.stdout.on('data', bytes => {
        buffer += bytes.toString()
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
          try {
            const message = JSON.parse(line)
            kinds.push(message.kind)
            if (message.kind === 'ready') { clearTimeout(timer); resolve() }
          } catch { clearTimeout(timer); reject(new Error('GUARD_BAD_FRAME')) }
        }
      })
    })
    try { for (let i = 0; i < 3; i++) await probeEcho(name, Buffer.from(`交接-${i}`), 2000) } catch (error) { echoError = error }
  } finally {
    child.stdin.end()
    const kill = setTimeout(() => child.kill(), 5000)
    await closed; clearTimeout(kill); await diagnostic.cleanup()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  expect(diagnostic.manifest.diagnosticOnly).toBe(true)
  expect(kinds).not.toContain('handoff-missing')
  expect(echoError).toBeUndefined()
  expect(exitCode).toBe(0)
  expect(kinds.filter(kind => kind === 'instance')).toHaveLength(4)
})

const endpoint = () => `\\\\.\\pipe\\mimir-assets-${randomUUID()}`
it.runIf(process.platform === 'win32')('真实原生实例连续转发、每实例句柄权限、关闭取消等待', async () => {
  const sockets = new Set<Socket>()
  const server = createServer(s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.pipe(s) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const audits: PipeAudit[] = []
  const name = endpoint()
  const relay = await startWindowsPipeRelay({ artifact, endpoint: name, port: (server.address() as {port: number}).port, onAudit: a => audits.push(a) })
  try {
    for (let i = 0; i < 3; i++) {
      const s = createConnection(name)
      const value = Buffer.from(`原文-${i}\r\n`)
      const echoed = new Promise<Buffer>((resolve, reject) => { s.once('data', resolve); s.once('error', reject) })
      s.write(value)
      expect(await echoed).toEqual(value)
      s.destroy()
    }
    expect(audits.length).toBeGreaterThanOrEqual(3)
    for (const [i, a] of audits.entries()) {
      expect(a.ordinal).toBe(i + 1)
      expect(a.rejectRemote).toBe(true)
      expect(a.ownerSid).toMatch(/^S-1-5-/)
      expect(a.dacl).toContain('(D;;FA;;;NU)')
      expect(a.dacl.match(/\(A;/g)).toHaveLength(1)
      expect(a.dacl).toContain(`;;;${a.ownerSid})`)
    }
  } finally {
    await relay.close()
    for (const s of sockets) s.destroy()
    await new Promise<void>(r => server.close(() => r()))
  }
  expect(await relay.closed).toEqual({ expected: true })
  await relay.close()
})
it('非法端点和端口在启动前拒绝', async () => {
  for (const args of [{ endpoint: 'bad', port: 12 }, { endpoint: endpoint(), port: 0 }, { endpoint: endpoint(), port: 1.5 }]) {
    await expect(startWindowsPipeRelay({ ...args, artifact })).rejects.toMatchObject({ code: 'BAD_ENDPOINT' })
  }
})
it.runIf(process.platform === 'win32')('同名占用失败且安全错误不泄漏；关闭已接客户端', async () => {
  const name = endpoint()
  const first = await startWindowsPipeRelay({ artifact, endpoint: name, port: 12345 })
  try {
    await expect(startWindowsPipeRelay({ artifact, endpoint: name, port: 12345 })).rejects.toMatchObject({ code: 'DISCONNECTED', message: '本机连接已关闭。' })
    const s = createConnection(name)
    s.on('error', () => {})
    await new Promise<void>(r => s.once('connect', r))
    const ended = new Promise<void>(r => s.once('close', () => r()))
    await first.close()
    await ended
  } finally { await first.close() }
})
it.runIf(process.platform === 'win32')('并发超限最多16实例，退出不遗留连接', async () => {
  const accepted = new Set<Socket>()
  const server = createServer(s => { accepted.add(s); s.on('close', () => accepted.delete(s)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const audits: PipeAudit[] = []
  const name = endpoint()
  const relay = await startWindowsPipeRelay({ artifact, endpoint: name, port: (server.address() as {port:number}).port, onAudit: a => audits.push(a) })
  const clients = Array.from({length: 24}, () => { const s = createConnection(name); s.on('error', () => {}); return s })
  try {
    await new Promise(r => setTimeout(r, 300))
    expect(audits.length).toBe(16)
    expect(accepted.size).toBe(15)
    await relay.close()
    expect(await relay.closed).toEqual({ expected: true })
    for (let i = 0; i < 50 && accepted.size; i++) await new Promise(r => setTimeout(r, 20))
    expect(accepted.size).toBe(0)
  } finally {
    for (const s of clients) s.destroy()
    await relay.close()
    for (const s of accepted) s.destroy()
    await new Promise<void>(r => server.close(() => r()))
  }
})
it.runIf(process.platform === 'win32')('2MiB双向流背压保留全部字节，断连后可重新连接', async () => {
  const sockets = new Set<Socket>()
  const server = createServer(s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.pipe(s) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const name = endpoint()
  const relay = await startWindowsPipeRelay({ artifact,endpoint:name, port:(server.address() as {port:number}).port})
  try {
    for (let i = 0; i < 2; i++) {
      const body = Buffer.alloc(2 * 1024 * 1024, i + 37)
      const s = createConnection(name), chunks:Buffer[] = []
      const received = new Promise<Buffer>((r, e) => {
        let length = 0
        s.on('data', b => { chunks.push(b); length += b.length; if (length === body.length) r(Buffer.concat(chunks)) })
        s.once('error', e)
        s.setTimeout(5000, () => s.destroy(new Error('transfer timeout')))
      })
      s.write(body)
      expect(await received).toEqual(body)
      s.destroy()
    }
  } finally { await relay.close(); for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())) }
})
for (const phase of ['spawn', 'ready'] as const) it.runIf(process.platform === 'win32')(`父进程在${phase}阶段死亡时控制EOF回收helper`, async () => {
  const name = endpoint()
  const parent = spawn(process.execPath, ['test/fixtures/assetsPipeParent.cjs'], { env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: process.env.TEMP, ARTIFACT: join(process.cwd(), '.native/assets-pipe-helper/win-x64'), ENDPOINT: name }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  parent.stderr.resume()
  let helper = 0
  await new Promise<void>((resolve, reject) => {
    let buffer = ''
    parent.stdout.on('data', b => {
      buffer += b.toString()
      const pid = /PID:(\d+)/.exec(buffer)
      if (pid) helper = Number(pid[1])
      if (helper && (phase === 'spawn' || buffer.includes('"kind":"ready"'))) resolve()
    })
    parent.once('error', reject)
    parent.once('exit', () => reject(new Error('parent exited before phase')))
  })
  parent.kill()
  await new Promise<void>(r => parent.once('close', () => r()))
  let exists = true
  for (let i = 0; i < 100 && exists; i++) {
    try { process.kill(helper, 0) } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); exists = false; break }
    await new Promise(r => setTimeout(r, 100))
  }
  expect(exists).toBe(false)
  // Process-exit visibility and named-object teardown are asynchronous on Windows.
  let unavailable = false
  for (let i = 0; i < 30 && !unavailable; i++) {
    const client = createConnection(name)
    unavailable = await new Promise<boolean>(r => { client.once('error', () => r(true)); client.once('connect', () => r(false)) })
    client.destroy()
    if (!unavailable) await new Promise(r => setTimeout(r, 100))
  }
  expect(unavailable).toBe(true)
})
