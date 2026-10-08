import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as childProcess from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { startWindowsPipeRelay } from '../../../electron/assets/mcp/windowsPipeRelay'

vi.mock('node:child_process', async original => ({...await original<typeof childProcess>(), spawn: vi.fn()}))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
it.runIf(process.platform === 'win32')('多条合法审计合并超过8KiB不误杀，单帧超长仍拒绝', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 99999, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', 1)); return true })
  })
  child.stdin.on('finish', () => child.emit('close', 0))
  vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess)
  const audit = (ordinal: number) => JSON.stringify({kind:'instance', ordinal, rejectRemote:true, ownerSid:'S-1-5-21-123-123-123-1001', dacl:'O:S-1-5-21-123-123-123-1001D:P(D;;FA;;;NU)(A;;FA;;;S-1-5-21-123-123-123-1001)'}) + '\n'
  const pending = startWindowsPipeRelay({endpoint:'\\\\.\\pipe\\mimir-assets-11111111-1111-4111-8111-111111111111', port:12345})
  child.stdout.write(audit(1) + '{"kind":"ready"}\n')
  const relay = await pending
  try {
    const coalesced = Array.from({length:100}, (_, i) => audit(i + 2)).join('')
    expect(Buffer.byteLength(coalesced)).toBeGreaterThan(8192)
    child.stdout.write(coalesced)
    expect(child.kill).not.toHaveBeenCalled()
    child.stdout.write('x'.repeat(8193))
    expect(child.kill).toHaveBeenCalledOnce()
    expect(await relay.closed).toEqual({expected:false})
  } finally { await relay.close() }
})
it.runIf(process.platform === 'win32')('控制EOF无响应时5秒后仅回收本child，并等待实际退出', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    pid:99999, stdin:new PassThrough(), stdout:new PassThrough(), stderr:new PassThrough(),
    kill:vi.fn(() => { child.emit('close', 1); return true })
  })
  vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess)
  const pending = startWindowsPipeRelay({endpoint:'\\\\.\\pipe\\mimir-assets-11111111-1111-4111-8111-111111111111', port:12345})
  child.stdout.write(JSON.stringify({kind:'instance', ordinal:1, rejectRemote:true, ownerSid:'S-1-5-21-123-1001', dacl:'protected'}) + '\n{"kind":"ready"}\n')
  const relay = await pending
  const closed = relay.close()
  await vi.advanceTimersByTimeAsync(4999)
  expect(child.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await closed
  expect(child.kill).toHaveBeenCalledOnce()
  expect(await relay.closed).toEqual({expected:true})
})
