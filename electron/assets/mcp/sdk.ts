/** 官方SDK协议壳仅连接已认证broker；不导入数据库/Electron/模型，不形成第二writer。 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Readable, Writable } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode
} from '@modelcontextprotocol/sdk/types.js'
import { ASSET_MCP_TOOLS, ASSET_RESOURCE_TEMPLATES, ASSET_MCP_PROMPTS } from './catalog'
import { BrokerError, MAX_FRAME_BYTES, safeBrokerError, type LocalAssetsClient } from './localTransport'

export function createAssetsMcpServer(client: LocalAssetsClient): Server {
  const server = new Server({ name: 'mimir-research-assets', version: '1.0.0' }, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: '仅访问已运行Mimir当前科研空间。写入须confirm=true并获桌面单次批准；本服务不调用模型。'
  })
  const validator = new AjvJsonSchemaValidator()
  const checks = new Map(ASSET_MCP_TOOLS.map(t => [t.name, validator.getValidator(t.inputSchema)]))
  server.onclose = () => { void client.close() }
  async function call(method: string, args: Record<string, unknown>, signal: AbortSignal) {
    const cancel = () => { void client.close() }
    if (signal.aborted) throw new BrokerError('DISCONNECTED')
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await client.call(method, args)
      if (signal.aborted) throw new BrokerError('DISCONNECTED')
      return result as { requestId: string; data: Record<string, unknown> }
    } finally { signal.removeEventListener('abort', cancel) }
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ASSET_MCP_TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const check = checks.get(request.params.name)
      if (!check) throw new BrokerError('METHOD_NOT_FOUND')
      const args = request.params.arguments ?? {}
      if (!check(args).valid) throw new BrokerError('BAD_REQUEST')
      const result = await call(request.params.name, args, extra.signal)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) {
      const safe = safeBrokerError(error), result = { error: { code: safe.code, message: safe.message } }
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
    }
  })
  // URI模板属于resources/templates/list；不把uriTemplate伪装成具体resource.uri。
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: ASSET_RESOURCE_TEMPLATES }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    try {
      const uri = request.params.uri
      const asset = /^asset:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/version\/([1-9]\d*))?$/.exec(uri)
      let data: unknown
      if (asset && asset[1].length <= 100) {
        const historical = asset[2] !== undefined
        const result = await call(historical ? 'get_asset_version' : 'get_asset', { assetCode: asset[1], ...(historical ? { version: Number(asset[2]) } : {}) }, extra.signal)
        const a = result.data, body = a.content as { content: string; truncated: boolean }
        data = { asset: { code: a.assetCode, ...(historical ? {} : { name: a.name, category: a.category, kind: a.kind }), storageType: a.storageType },
          version: { version: a.version, content: body.content, truncated: body.truncated, fileName: a.fileName, fileAvailable: a.fileAvailable } }
      } else {
        const category = /^category:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(uri)
        if (!category || category[1].length > 100) throw new BrokerError('BAD_REQUEST')
        const list = (await call('list_categories', {}, extra.signal)).data as unknown as Array<{ code: string }>
        const found = list.find(c => c.code === category[1])
        if (!found) throw new BrokerError('BAD_CATEGORY')
        data = { category: found, assets: (await call('search_assets', { categoryCode: category[1], page: 1, pageSize: 100 }, extra.signal)).data }
      }
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] }
    } catch (error) {
      const safe = safeBrokerError(error)
      throw new McpError(ErrorCode.InvalidParams, safe.message, { code: safe.code })
    }
  })
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: ASSET_MCP_PROMPTS }))
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    const definition = ASSET_MCP_PROMPTS.find(p => p.name === request.params.name), args = request.params.arguments ?? {}
    if (!definition || Object.keys(args).some(k => !definition.arguments.some(a => a.name === k)) || Object.values(args).some(v => v.includes('\u0000')) ||
      definition.arguments.some(a => 'required' in a && a.required && !args[a.name]?.trim()) || Buffer.byteLength(JSON.stringify(args)) > 60000) {
      throw new McpError(ErrorCode.InvalidParams, 'Prompt名称或参数非法。')
    }
    let text: string
    if (definition.name === 'research_asset_review') {
      text = `请用 search_assets 搜索以下条件，再用 get_asset 读取候选：${JSON.stringify(args)}。引用时注明资产code/version。本服务不自动调用模型或写入。`
    } else {
      if (args.kind && !['thought', 'rule', 'file', 'prompt'].includes(args.kind)) throw new McpError(ErrorCode.InvalidParams, '条目类型非法。')
      text = `请整理以下完整拟保存结果：${JSON.stringify(args)}。先展示摘要、标签和参见，用户确认后才用 create_asset 或 update_metadata；confirm=true仍需桌面批准。本服务不自动调用模型。`
    }
    return { description: definition.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] }
  })
  return server
}

/** 调用者负责认证连接和生命周期；生产CLI从受保护发现文件连接。stdout仅供SDK协议使用。 */
export async function startAssetsMcpStdio(client: LocalAssetsClient, streams: { input?: Readable; output?: Writable } = {}): Promise<Server> {
  const server = createAssetsMcpServer(client)
  const input = streams.input ?? process.stdin, output = streams.output ?? process.stdout
  let closing = false
  const stop = () => { if (!closing) { closing = true; void server.close().catch(() => client.close()) } }
  const detach = () => {
    input.removeListener('end', stop); input.removeListener('close', stop); input.removeListener('error', stop)
    output.removeListener('close', stop); output.removeListener('error', stop)
  }
  server.onclose = () => { closing = true; detach(); void client.close() }
  input.once('end', stop); input.once('close', stop); input.once('error', stop)
  output.once('close', stop); output.once('error', stop)
  try {
    await server.connect(new StdioServerTransport(input, output, { maxBufferSize: MAX_FRAME_BYTES }))
    if (input.destroyed || input.readableEnded || output.destroyed) stop()
    return server
  } catch (error) { detach(); await client.close(); throw safeBrokerError(error) }
}
