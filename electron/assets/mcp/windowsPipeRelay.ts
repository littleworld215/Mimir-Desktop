import { spawn } from 'node:child_process'
import { dirname, isAbsolute } from 'node:path'
import { assertLocalEndpoint, BrokerError } from './localTransport'
import { resolveWindowsPipeArtifact, type PipeArtifactLocation } from './windowsPipeArtifact'

export interface PipeAudit { kind: 'instance'; ordinal: number; rejectRemote: true; ownerSid: string; dacl: string }
export interface WindowsPipeRelay { readonly pid: number; readonly closed: Promise<{expected: boolean}>; close(): Promise<void> }

/** Native handles belong solely to this child; all broker authentication stays in the parent. */
export async function startWindowsPipeRelay(options: { endpoint: string; port: number; artifact: PipeArtifactLocation; signal?: AbortSignal; onAudit?: (audit: PipeAudit) => void }): Promise<WindowsPipeRelay> {
  assertLocalEndpoint(options.endpoint)
  if (process.platform !== 'win32' || process.arch !== 'x64' || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new BrokerError('BAD_ENDPOINT')
  const deadline = Date.now() + 20_000
  const validation = new AbortController()
  const signal = options.signal ? AbortSignal.any([validation.signal, options.signal]) : validation.signal
  const validating = setTimeout(() => validation.abort(), 20_000)
  let executable: string
  try {
    signal.throwIfAborted()
    executable = (await resolveWindowsPipeArtifact(options.artifact, signal)).executable
    signal.throwIfAborted()
  } catch { throw new BrokerError('DISCONNECTED') } finally { clearTimeout(validating) }
  const windows = process.env.SystemRoot ?? process.env.WINDIR
  if (!windows || !isAbsolute(windows)) throw new BrokerError('DISCONNECTED')
  const child = spawn(executable, [], {
    cwd: dirname(executable), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: windows, WINDIR: windows, TEMP: process.env.TEMP, TMP: process.env.TMP,
      MIMIR_PIPE_ENDPOINT: options.endpoint, MIMIR_PIPE_PORT: String(options.port) }
  })
  let expected = false, ready = false, ordinal = 0, buffer = '', closing: Promise<void> | undefined
  let settled = false, failed = false
  let finish!: (value: {expected: boolean}) => void
  const closed = new Promise<{expected: boolean}>(r => { finish = r })
  let accept!: () => void, reject!: (error: BrokerError) => void
  const started = new Promise<void>((r, e) => { accept = r; reject = e })
  const fail = () => { if (failed || settled) return; failed = true; reject(new BrokerError('DISCONNECTED')); child.kill() }
  const timer = setTimeout(fail, Math.max(1, deadline - Date.now()))
  const onClosed = () => {
    if (settled) return
    settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort)
    reject(new BrokerError('DISCONNECTED')); finish({ expected })
  }
  child.on('error', onClosed)
  child.on('close', onClosed)
  child.stdin.on('error', () => {})
  child.stderr.resume() // Never forward compilation paths, raw exceptions, or environment.
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (failed || settled) return
    // OS reads may coalesce many valid frames. Bound each frame/tail, not their sum.
    if (Buffer.byteLength(chunk) > 1_048_576) { fail(); return }
    let offset = 0, frames = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset)
      const end = newline === -1 ? chunk.length : newline
      const piece = chunk.slice(offset, end)
      if (Buffer.byteLength(buffer) + Buffer.byteLength(piece) > 8192) { fail(); return }
      buffer += piece
      if (newline === -1) return
      if (++frames > 4096) { fail(); return }
      const line = buffer.trim(); buffer = ''; offset = newline + 1
      try {
        const message = JSON.parse(line)
        if (message.kind === 'instance' && message.ordinal === ordinal + 1 && message.rejectRemote === true && /^S-1-5-/.test(message.ownerSid) && typeof message.dacl === 'string' && message.dacl.length < 4096) {
          ordinal++; options.onAudit?.(message)
        } else if (message.kind === 'ready' && !ready && ordinal === 1) {
          ready = true; clearTimeout(timer); accept()
        } else { fail(); return }
      } catch { fail(); return }
    }
  })
  const close = () => closing ??= (async () => {
    expected = true; child.stdin.end()
    const kill = setTimeout(() => child.kill(), 5000)
    try { await closed } finally { clearTimeout(kill) }
  })()
  const onAbort = () => { void close(); if (!ready) fail() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  try { await started } catch (error) { await close(); throw error }
  return { pid: child.pid!, closed, close }
}
