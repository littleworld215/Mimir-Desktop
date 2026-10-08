/** 独立外部单次确认：没有Agent策略、记住批准或全权放行路径。 */
import type { MessageBoxOptions } from 'electron'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import { ASSET_MCP_TOOLS } from './catalog'
import { MCP_WRITE_TOOLS, type BrokerRequest } from './broker'
import type { WorkspaceRequest } from '../../../shared/assetsContracts'

const validator = new AjvJsonSchemaValidator()
const checks = new Map(ASSET_MCP_TOOLS.map(t => [t.name, validator.getValidator(t.inputSchema)]))
// 原生弹框不适合作为长文编辑器。拒绝超限请求，绝不截断后让用户批准不可见内容。
export const MAX_APPROVAL_BYTES = 48_000
export function createExternalApproval<W extends { isDestroyed(): boolean }>(options: {
  window: () => W | null
  currentScope: () => WorkspaceRequest
  preview?: (request: BrokerRequest) => Promise<Record<string, unknown>>
  show: (window: W, options: MessageBoxOptions) => Promise<{ response: number }>
}): (request: BrokerRequest) => Promise<boolean> {
  let pending = false
  return async request => {
    if (pending) return false
    let timer: ReturnType<typeof setInterval> | undefined
    const controller = new AbortController()
    const abort = () => controller.abort()
    try {
      const window = options.window()
      const current = () => {
        const scope = options.currentScope()
        return !request.signal.aborted && !window?.isDestroyed() && scope.workspaceId === request.scope.workspaceId && scope.spaceEpoch === request.scope.spaceEpoch
      }
      if (!window || !current() || !(MCP_WRITE_TOOLS as readonly string[]).includes(request.method) || request.args.confirm !== true || !checks.get(request.method)?.(request.args).valid) return false
      if (request.method === 'adopt_ai_draft' && !options.preview) return false
      pending = true
      request.signal.addEventListener('abort', abort, { once: true })
      timer = setInterval(() => { try { if (!current()) abort() } catch { abort() } }, 100)
      timer.unref?.()
      const preview = options.preview ? await options.preview(request) : {}
      const detail = `客户端自报（非身份认证）：${JSON.stringify(request.client)}\n科研空间：${JSON.stringify(request.scope.workspaceId)}\n操作：${request.method}\n\n完整拟写入参数：\n${JSON.stringify(request.args, null, 2)}\n\n本机草稿采纳预览：\n${JSON.stringify(preview, null, 2)}\n\n取消、超时或切换空间后，此批准失效。超过48KB的请求会拒绝，请拆小或在桌面编辑。`
      if (!current() || controller.signal.aborted || Buffer.byteLength(detail, 'utf8') > MAX_APPROVAL_BYTES) return false
      const result = await options.show(window, { type: 'warning', title: '外部客户端请求写入科研资产', message: '是否允许这一次写入？', detail,
        buttons: ['拒绝', '允许这一次'], defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal })
      return result.response === 1 && !controller.signal.aborted && current()
    } catch { return false } finally { if (timer) clearInterval(timer); request.signal.removeEventListener('abort', abort); pending = false }
  }
}
