import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { WorkspaceRequest } from '../../../shared/assetsContracts'

export const MAX_FRAME_BYTES = 1024 * 1024
const messages = {
  APP_NOT_RUNNING: '请先启动 Mimir 桌面应用。', UNAUTHORIZED: '本机会话认证失败。',
  BAD_ENDPOINT: '只允许本机专用管道或绝对路径 socket。', BAD_REQUEST: '请求格式非法。',
  METHOD_NOT_FOUND: '不支持此方法。', CONFIRM_REQUIRED: '写操作需要 confirm=true。',
  APPROVAL_DENIED: '外部写请求未获用户批准。', SPACE_CHANGED: '科研空间已变化，请重新连接。',
  DISCONNECTED: '本机连接已关闭。', TIMEOUT: '本机请求已超时。',
  PAYLOAD_TOO_LARGE: '请求或结果超过传输上限。', INTERNAL_ERROR: '资产请求失败。', BUSY: '当前连接已有请求。',
  NOT_FOUND: '资产或条目不存在。', VERSION_CONFLICT: '正文版本已变化，请重新读取。',
  REVISION_CONFLICT: '资产已修改，请重新读取。', ASSET_ARCHIVED: '请先恢复归档资产。', BAD_CATEGORY: '分类不存在。'
} as const
export type BrokerErrorCode = keyof typeof messages
export class BrokerError extends Error {
  constructor(readonly code: BrokerErrorCode) { super(messages[code]) }
}
export function safeBrokerError(error: unknown): BrokerError {
  const code = error instanceof BrokerError && Object.hasOwn(messages, error.code) ? error.code : 'INTERNAL_ERROR'
  return new BrokerError(code)
}
export function localEndpoint(directory: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\mimir-assets-${randomUUID()}` : join(directory, `m-${randomUUID()}.sock`)
}
export function assertLocalEndpoint(endpoint: string): void {
  const valid = process.platform === 'win32'
    ? /^\\\\\.\\pipe\\mimir-assets-[\da-f-]{36}$/.test(endpoint)
    : isAbsolute(endpoint) && !endpoint.includes('\u0000') && endpoint.endsWith('.sock')
  if (!valid) throw new BrokerError('BAD_ENDPOINT')
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError('BAD_REQUEST')
  return value as Record<string, unknown>
}
/** 按字节限额；Buffer 拼帧避免分片把 UTF8 多字节正文损坏。 */
export function receiveFrames(socket: Socket, maxBytes: number, receive: (value: unknown) => void, fail: (error: BrokerError) => void): void {
  let pending = Buffer.alloc(0)
  socket.on('data', (data: Buffer) => {
    if (socket.destroyed) return
    // 单次数据也受限，避免攻击者一次塞入大量小帧造成无界解析。
    if (data.length > maxBytes || pending.length + data.length > maxBytes) { fail(new BrokerError('PAYLOAD_TOO_LARGE')); return }
    pending = Buffer.concat([pending, data])
    let end: number
    while ((end = pending.indexOf(10)) !== -1) {
      const frame = pending.subarray(0, end); pending = pending.subarray(end + 1)
      try { receive(JSON.parse(frame.toString('utf8'))) } catch { fail(new BrokerError('BAD_REQUEST')); return }
      if (socket.destroyed) return
    }
  })
}
export function encodeFrame(value: unknown, maxBytes: number): string {
  const result = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(result, 'utf8') > maxBytes) throw new BrokerError('PAYLOAD_TOO_LARGE')
  return result
}
export interface LocalAssetsClient {
  readonly scope: Readonly<WorkspaceRequest>
  readonly closed?: Promise<void>
  call(method: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}
/** 仅连接已运行应用；不导入数据库、Electron、模型或 seed。 */
export function connectAssetsBroker(options: { endpoint: string; token: string; client: string; timeoutMs?: number; keepAliveMs?: number }): Promise<LocalAssetsClient> {
  return new Promise((resolve, reject) => {
    const keepAliveMs = options.keepAliveMs ?? 0
    try { assertLocalEndpoint(options.endpoint); if (!Number.isSafeInteger(keepAliveMs) || (keepAliveMs !== 0 && (keepAliveMs < 10 || keepAliveMs > 60000))) throw new BrokerError('BAD_REQUEST') } catch (e) { reject(e); return }
    const socket = connect(options.endpoint)
    let heartbeat: NodeJS.Timeout | undefined
    let notifyClosed!: () => void
    const closed = new Promise<void>(done => { notifyClosed = done })
    let established = false, id = 0
    let waiting: { id: number; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null
    const timeoutMs = options.timeoutMs ?? 125_000
    const helloTimer = setTimeout(() => { reject(new BrokerError('TIMEOUT')); socket.destroy() }, Math.min(timeoutMs, 5000))
    const fail = (error: BrokerError) => {
      clearTimeout(helloTimer)
      if (heartbeat) clearInterval(heartbeat)
      if (!established) reject(error)
      if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); waiting = null }
      socket.destroy()
    }
    socket.on('error', () => fail(new BrokerError(established ? 'DISCONNECTED' : 'APP_NOT_RUNNING')))
    socket.on('close', () => { fail(new BrokerError('DISCONNECTED')); notifyClosed() })
    socket.once('connect', () => {
      try { socket.write(encodeFrame({ type: 'hello', token: options.token, client: options.client }, MAX_FRAME_BYTES)) } catch { fail(new BrokerError('BAD_REQUEST')) }
    })
    receiveFrames(socket, MAX_FRAME_BYTES, value => {
      const reply = object(value)
      // 保活是已认证会话的控制帧，不占工具序号、不触发业务、不重放写入。
      if (established && reply.type === 'pong' && Object.keys(reply).length === 1) return
      if (typeof reply.ok !== 'boolean') { fail(new BrokerError('BAD_REQUEST')); return }
      const code = typeof reply.code === 'string' && Object.hasOwn(messages, reply.code) ? reply.code as BrokerErrorCode : 'INTERNAL_ERROR'
      if (!established) {
        if (reply.id !== 0 || !reply.ok) { fail(new BrokerError(code)); return }
        const scope = object(reply.scope)
        if (typeof scope.workspaceId !== 'string' || typeof scope.spaceEpoch !== 'string') { fail(new BrokerError('BAD_REQUEST')); return }
        established = true; clearTimeout(helloTimer)
        if (keepAliveMs) {
          heartbeat = setInterval(() => {
            try { if (!socket.destroyed) socket.write(encodeFrame({ type: 'ping' }, MAX_FRAME_BYTES)) } catch { fail(new BrokerError('DISCONNECTED')) }
          }, keepAliveMs)
          heartbeat.unref?.()
        }
        resolve({
          closed,
          scope: Object.freeze({ workspaceId: scope.workspaceId, spaceEpoch: scope.spaceEpoch }),
          call(method, args) {
            if (socket.destroyed) return Promise.reject(new BrokerError('DISCONNECTED'))
            if (waiting) return Promise.reject(new BrokerError('BUSY'))
            return new Promise((resolveCall, rejectCall) => {
              const requestId = id + 1
              let frame: string
              try { frame = encodeFrame({ id: requestId, method, args }, MAX_FRAME_BYTES) } catch { rejectCall(new BrokerError('PAYLOAD_TOO_LARGE')); return }
              id = requestId
              waiting = { id: requestId, resolve: resolveCall, reject: rejectCall, timer: setTimeout(() => fail(new BrokerError('TIMEOUT')), timeoutMs) }
              socket.write(frame)
            })
          },
          close() {
            if (socket.destroyed) return Promise.resolve()
            return new Promise<void>(done => { socket.once('close', done); socket.destroy() })
          }
        })
        return
      }
      if (!waiting || reply.id !== waiting.id) { fail(new BrokerError('BAD_REQUEST')); return }
      const current = waiting; waiting = null; clearTimeout(current.timer)
      if (reply.ok) current.resolve(reply.data)
      else current.reject(new BrokerError(code))
    }, fail)
  })
}
