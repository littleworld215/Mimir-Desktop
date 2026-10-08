import { spawn } from 'node:child_process'
import { assertLocalEndpoint, BrokerError } from './localTransport'
import { WINDOWS_PIPE_SOURCE } from './windowsPipeSource'

export interface PipeAudit { kind: 'instance'; ordinal: number; rejectRemote: true; ownerSid: string; dacl: string }
export interface WindowsPipeRelay { readonly pid: number; readonly closed: Promise<{expected: boolean}>; close(): Promise<void> }

/** Native handles belong solely to this child; all broker authentication stays in the parent. */
export async function startWindowsPipeRelay(options: { endpoint: string; port: number; onAudit?: (audit: PipeAudit) => void }): Promise<WindowsPipeRelay> {
  assertLocalEndpoint(options.endpoint)
  if (process.platform !== 'win32' || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new BrokerError('BAD_ENDPOINT')
  const script = '$ErrorActionPreference="Stop"; try { Add-Type -TypeDefinition $env:MIMIR_PIPE_SOURCE -Language CSharp; [AssetsNativePipe]::Run($env:MIMIR_PIPE_ENDPOINT,[int]$env:MIMIR_PIPE_PORT) } catch { exit 1 }; exit [Environment]::ExitCode'
  const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: process.env.TEMP, TMP: process.env.TMP,
      MIMIR_PIPE_SOURCE: WINDOWS_PIPE_SOURCE, MIMIR_PIPE_ENDPOINT: options.endpoint, MIMIR_PIPE_PORT: String(options.port) }
  })
  let expected = false, ready = false, ordinal = 0, buffer = '', closing: Promise<void> | undefined
  let settled = false, failed = false
  let finish!: (value: {expected: boolean}) => void
  const closed = new Promise<{expected: boolean}>(r => { finish = r })
  let accept!: () => void, reject!: (error: BrokerError) => void
  const started = new Promise<void>((r, e) => { accept = r; reject = e })
  const fail = () => { if (failed || settled) return; failed = true; reject(new BrokerError('DISCONNECTED')); child.kill() }
  const timer = setTimeout(fail, 20_000)
  const onClosed = () => {
    if (settled) return
    settled = true; clearTimeout(timer)
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
  try { await started } catch (error) { await close(); throw error }
  return { pid: child.pid!, closed, close }
}
