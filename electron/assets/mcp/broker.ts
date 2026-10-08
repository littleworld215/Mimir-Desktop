import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { chmodSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WorkspaceRequest } from '../../../shared/assetsContracts'
import { assertLocalEndpoint, BrokerError, encodeFrame, MAX_FRAME_BYTES, object, receiveFrames, safeBrokerError } from './localTransport'

export const MCP_READ_TOOLS = ['search_assets', 'get_asset', 'get_asset_version', 'list_categories', 'list_tags', 'get_refgraph', 'list_saved_filters'] as const
export const MCP_WRITE_TOOLS = ['create_asset', 'update_metadata', 'add_tags', 'remove_tags', 'add_reference', 'save_ai_draft', 'adopt_ai_draft'] as const
export type McpToolName = typeof MCP_READ_TOOLS[number] | typeof MCP_WRITE_TOOLS[number]
export interface BrokerRequest {
  readonly client: string
  readonly scope: Readonly<WorkspaceRequest>
  readonly method: McpToolName
  readonly args: Record<string, unknown>
  readonly signal: AbortSignal
}
export interface AssetsBrokerOptions {
  endpoint: string
  currentScope: () => WorkspaceRequest
  /** 接现有主进程服务；业务写入还必须用该scope/signal的事务守卫。 */
  dispatch: (request: BrokerRequest) => Promise<unknown>
  /** 外部专门批准来源；缺省拒绝，禁止用Agent全权档自动放行。 */
  approve?: (request: BrokerRequest) => Promise<boolean>
  timeoutMs?: number
  maxBytes?: number
  maxHostOperations?: number
}
/** 只提供传输接缝；尚未挂到主应用、发布发现凭据或代替 MCP SDK。 */
export async function startAssetsBroker(options: AssetsBrokerOptions): Promise<{ endpoint: string; token: string; close: () => Promise<void> }> {
  assertLocalEndpoint(options.endpoint)
  const maxBytes = options.maxBytes ?? MAX_FRAME_BYTES, timeoutMs = options.timeoutMs ?? 120_000
  const maxHostOperations = options.maxHostOperations ?? 32
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_FRAME_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) throw new BrokerError('BAD_REQUEST')
  if (!Number.isSafeInteger(maxHostOperations) || maxHostOperations < 1 || maxHostOperations > 32) throw new BrokerError('BAD_REQUEST')
  if (process.platform !== 'win32') {
    // Unix socket 路径必须位于仅当前用户可访问的目录；Windows后续发现文件继承用户目录ACL。
    const parent = statSync(dirname(options.endpoint))
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) throw new BrokerError('BAD_ENDPOINT')
  }
  const token = randomBytes(32).toString('base64url')
  const sockets = new Set<Socket>()
  let closed = false
  let hostOperations = 0
  const server = createServer(socket => {
    if (closed || sockets.size >= 16) { socket.destroy(); return }
    sockets.add(socket)
    let scope: Readonly<WorkspaceRequest> | null = null, client = '', sequence = 0, controller: AbortController | null = null, terminal = false
    const destroy = () => { terminal = true; controller?.abort(); socket.destroy() }
    socket.on('error', destroy)
    socket.on('close', () => { terminal = true; controller?.abort(); sockets.delete(socket) })
    socket.setTimeout(5000, destroy)
    const send = (value: unknown) => socket.write(encodeFrame(value, maxBytes))
    const failure = (id: number, error: unknown) => {
      const safe = safeBrokerError(error)
      try { send({ id, ok: false, code: safe.code, message: safe.message }) } catch { destroy() }
    }
    const rejectSession = (id: number, error: BrokerError) => {
      // 先终止批准再发送错误；半开对端和同包后续帧都不能恢复会话。
      terminal = true; controller?.abort()
      failure(id, error); socket.destroySoon()
    }
    const guard = (signal: AbortSignal) => {
      if (closed || terminal || socket.destroyed || signal.aborted) throw new BrokerError('DISCONNECTED')
      const current = options.currentScope()
      if (!scope || current.workspaceId !== scope.workspaceId || current.spaceEpoch !== scope.spaceEpoch) throw new BrokerError('SPACE_CHANGED')
    }
    receiveFrames(socket, maxBytes, value => {
      if (terminal) return
      const v = object(value)
      if (!scope) {
        if (Object.keys(v).some(k => !['type', 'token', 'client'].includes(k)) || v.type !== 'hello' || typeof v.token !== 'string' || Buffer.byteLength(v.token) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(v.token), Buffer.from(token))) {
          rejectSession(0, new BrokerError('UNAUTHORIZED')); return
        }
        if (typeof v.client !== 'string' || !v.client.trim() || v.client.length > 80 || /[\u0000-\u001f\u007f]/.test(v.client)) { rejectSession(0, new BrokerError('BAD_REQUEST')); return }
        const current = options.currentScope()
        if (!current.workspaceId || !current.spaceEpoch) { rejectSession(0, new BrokerError('SPACE_CHANGED')); return }
        scope = Object.freeze({ ...current }); client = v.client
        socket.setTimeout(180_000)
        send({ id: 0, ok: true, scope })
        return
      }
      if (v.type === 'ping' && Object.keys(v).length === 1) {
        try { guard(new AbortController().signal); send({ type: 'pong' }) } catch (error) { rejectSession(-1, safeBrokerError(error)) }
        return
      }
      if (controller) { rejectSession(typeof v.id === 'number' ? v.id : -1, new BrokerError('BUSY')); return }
      if (hostOperations >= maxHostOperations) { rejectSession(typeof v.id === 'number' ? v.id : -1, new BrokerError('BUSY')); return }
      if (Object.keys(v).some(k => !['id', 'method', 'args'].includes(k)) || v.id !== sequence + 1 || sequence >= 1024) { destroy(); return }
      sequence++
      const id = sequence
      const active = new AbortController(); controller = active
      const timer = setTimeout(() => active.abort(new BrokerError('TIMEOUT')), timeoutMs)
      let removeAbort = () => {}
      const aborted = new Promise<never>((_, reject) => {
        const listener = () => reject(active.signal.reason instanceof BrokerError ? active.signal.reason : new BrokerError('DISCONNECTED'))
        active.signal.addEventListener('abort', listener, { once: true })
        removeAbort = () => active.signal.removeEventListener('abort', listener)
      })
      const operation = async () => {
        if (typeof v.method !== 'string' || ![...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS].includes(v.method as McpToolName)) throw new BrokerError('METHOD_NOT_FOUND')
        const args = object(v.args)
        if (Object.keys(args).some(k => ['workspaceId', 'spaceEpoch', 'path', 'root', 'apiKey', 'provider', 'sql'].includes(k))) throw new BrokerError('BAD_REQUEST')
        const request: BrokerRequest = { scope: scope!, client, method: v.method as McpToolName, args, signal: active.signal }
        guard(active.signal)
        if ((MCP_WRITE_TOOLS as readonly string[]).includes(request.method)) {
          if (args.confirm !== true) throw new BrokerError('CONFIRM_REQUIRED')
          if (!options.approve || await options.approve(request) !== true) throw new BrokerError('APPROVAL_DENIED')
          guard(active.signal)
        }
        const result = await options.dispatch(request)
        guard(active.signal)
        return result
      }
      // race结束并不意味着忽略signal的宿主已结束；跨连接也占容量，实际settle才释放。
      hostOperations++
      const host = operation()
      void host.then(() => { hostOperations-- }, () => { hostOperations-- })
      void Promise.race([host, aborted]).then(data => {
        if (!terminal && !socket.destroyed) send({ id, ok: true, data })
      }).catch(error => { if (!terminal && !socket.destroyed) failure(id, error) }).finally(() => {
        clearTimeout(timer); removeAbort()
        if (controller === active) controller = null
      })
    }, () => destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.endpoint, () => { server.removeListener('error', reject); resolve() })
  })
  if (process.platform !== 'win32') chmodSync(options.endpoint, 0o600)
  return {
    endpoint: options.endpoint, token,
    close: async () => {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
    }
  }
}
