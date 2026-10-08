import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { createAsset, getAsset } from '../../../electron/assets/assetService'
import { dispatchAssetTool } from '../../../electron/assets/mcp/adapter'
import { startAssetsBroker } from '../../../electron/assets/mcp/broker'
import { connectAssetsBroker, localEndpoint } from '../../../electron/assets/mcp/localTransport'
import { createAssetsMcpServer, startAssetsMcpStdio } from '../../../electron/assets/mcp/sdk'

let root: string, manager: AssetsStoreManager, broker: Awaited<ReturnType<typeof startAssetsBroker>>
let client: Client, server: ReturnType<typeof createAssetsMcpServer>, allow: boolean
let approve: (signal: AbortSignal) => Promise<boolean>
let ctx: Awaited<ReturnType<AssetsStoreManager['getForRequest']>>
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-sdk-')); allow = false; approve = async () => allow
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
  createAsset(ctx, { code: 'fixture', name: '样本', category: 'inbox', storageType: 'inline_text', content: ' 原文 apiKey token\r\n\n' })
  broker = await startAssetsBroker({ endpoint: localEndpoint(root), currentScope: () => ctx.scope,
    dispatch: r => dispatchAssetTool(r, async () => ctx), approve: r => approve(r.signal) })
  server = createAssetsMcpServer(await connectAssetsBroker({ endpoint: broker.endpoint, token: broker.token, client: 'SDK 测试' }))
  client = new Client({ name: 'protocol-test', version: '1' })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  await server.connect(serverEnd); await client.connect(clientEnd)
})
afterEach(async () => { await client?.close(); await server?.close(); await broker?.close(); await manager?.close(); rmSync(root, { recursive: true, force: true }) })

it('官方SDK完成初始化，14方法严格schema及读写提示；正文不按敏感词改写', async () => {
  expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} })
  const tools = (await client.listTools()).tools
  expect(tools).toHaveLength(14)
  expect(new Set(tools.map(t => t.name)).size).toBe(14)
  expect(tools.every(t => t.inputSchema.additionalProperties === false)).toBe(true)
  expect(tools.find(t => t.name === 'create_asset')?.annotations).toMatchObject({ readOnlyHint: false })
  const read = await client.callTool({ name: 'get_asset', arguments: { assetCode: 'fixture' } })
  expect(read.structuredContent).toMatchObject({ data: { content: { content: ' 原文 apiKey token\r\n\n', truncated: false } } })
  expect(read.isError).not.toBe(true)
})

it('SDK写仍经桌面broker批准；拒绝零写、批准后历史与冲突可识别', async () => {
  const args = { name: '新建', categoryCode: 'inbox', content: 'v1', confirm: true }
  const denied = await client.callTool({ name: 'create_asset', arguments: args })
  expect(denied.isError).toBe(true)
  expect(denied.structuredContent).toMatchObject({ error: { code: 'APPROVAL_DENIED' } })
  expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(1)
  allow = true
  const created = (await client.callTool({ name: 'create_asset', arguments: args })).structuredContent as { data: { assetCode: string } }
  const assetCode = created.data.assetCode
  await client.callTool({ name: 'update_metadata', arguments: { assetCode, baseVersion: 1, content: 'v2', confirm: true } })
  const conflict = await client.callTool({ name: 'update_metadata', arguments: { assetCode, baseVersion: 1, name: '冲突', confirm: true } })
  expect(conflict.structuredContent).toMatchObject({ error: { code: 'VERSION_CONFLICT' } })
  expect((await client.readResource({ uri: `asset://${assetCode}/version/1` })).contents[0]).toMatchObject({ mimeType: 'application/json' })
})

it('资源模板有专用列表；当前/历史/分类为安全只读投影，严格拒绝无效URI', async () => {
  expect((await client.listResources()).resources).toEqual([])
  expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(3)
  const current = await client.readResource({ uri: 'asset://fixture' })
  expect(JSON.parse(current.contents[0].text as string)).toMatchObject({ asset: { code: 'fixture' }, version: { version: 1, content: ' 原文 apiKey token\r\n\n' } })
  expect(JSON.stringify(current)).not.toContain(root)
  const category = JSON.parse((await client.readResource({ uri: 'category://inbox' })).contents[0].text as string)
  expect(category.assets.items.map((a: { code: string }) => a.code)).toContain('fixture')
  for (const uri of ['file:///private', 'asset://fixture/version/0', 'asset://fixture?sql=x', 'category://..', 'asset://fixture/version/999']) {
    await expect(client.readResource({ uri })).rejects.toThrow()
  }
})

it('两个Prompt引用真实工具名且完整包含参数；不调用模型、不写库', async () => {
  expect((await client.listPrompts()).prompts).toHaveLength(2)
  const review = await client.getPrompt({ name: 'research_asset_review', arguments: { query: '量子', assetCodes: 'fixture' } })
  const reviewText = review.messages[0].content
  expect(reviewText).toMatchObject({ type: 'text' })
  expect(JSON.stringify(review)).toContain('search_assets'); expect(JSON.stringify(review)).toContain('get_asset')
  expect(JSON.stringify(review)).toContain('fixture')
  const restructure = await client.getPrompt({ name: 'research_asset_restructure', arguments: { title: '标题', categoryCode: 'inbox', content: ' 原文\n\n', kind: 'thought' } })
  expect(JSON.stringify(restructure)).toContain('create_asset')
  const promptText = (restructure.messages[0].content as { type: 'text'; text: string }).text
  const embedded = promptText.slice(promptText.indexOf('{'), promptText.lastIndexOf('}') + 1)
  expect(JSON.parse(embedded).content).toBe(' 原文\n\n')
  await expect(client.getPrompt({ name: 'research_asset_restructure', arguments: { title: '缺内容' } })).rejects.toThrow()
  await expect(client.getPrompt({ name: 'unknown' })).rejects.toThrow()
  expect(getAsset(ctx, 1).currentContent).toBe(' 原文 apiKey token\r\n\n')
  expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(1)
})

it('错误只返回固定code/message；未知方法/字段不泄露本地信息', async () => {
  const unknown = await client.callTool({ name: 'exec_sql', arguments: { path: root } })
  expect(unknown).toMatchObject({ isError: true, structuredContent: { error: { code: 'METHOD_NOT_FOUND' } } })
  const bad = await client.callTool({ name: 'get_asset', arguments: { assetCode: 'fixture', sql: root } })
  expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: 'BAD_REQUEST' } } })
  expect(JSON.stringify(bad)).not.toContain(root)
})

it('SDK取消中止broker会话，晚批准零写入且不会自动重新认证', async () => {
  let release!: (approved: boolean) => void, entered!: () => void
  const pending = new Promise<void>(r => { entered = r })
  let cancelled!: () => void
  const hostCancelled = new Promise<void>(r => { cancelled = r })
  approve = signal => { signal.addEventListener('abort', cancelled, { once: true }); entered(); return new Promise<boolean>(r => { release = r }) }
  const abort = new AbortController()
  const task = client.callTool({ name: 'create_asset', arguments: { name: '晚批准', categoryCode: 'inbox', content: 'x', confirm: true } }, undefined, { signal: abort.signal })
  const rejected = expect(task).rejects.toThrow()
  // 客户端拒绝不代表取消已到宿主；在批准前确认宿主已经观测断连。
  await pending; abort.abort(); await rejected; await hostCancelled
  release(true); await new Promise(r => setTimeout(r, 30))
  expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(1)
  expect((await client.callTool({ name: 'get_asset', arguments: { assetCode: 'fixture' } })).structuredContent).toMatchObject({ error: { code: 'DISCONNECTED' } })
})

it('官方stdio服务传输以SDK帧编解码完成握手/工具；不输出非协议日志', async () => {
  await client.close(); await server.close()
  server = createAssetsMcpServer(await connectAssetsBroker({ endpoint: broker.endpoint, token: broker.token, client: 'stdio 测试' }))
  const input = new PassThrough(), output = new PassThrough(), buffer = new ReadBuffer()
  const transport: Transport = {
    async start() { output.on('data', chunk => { buffer.append(chunk); let m; while ((m = buffer.readMessage()) !== null) transport.onmessage?.(m) }) },
    async send(message) { input.write(serializeMessage(message)) },
    async close() { input.destroy(); output.destroy(); transport.onclose?.() }
  }
  await server.connect(new StdioServerTransport(input, output))
  client = new Client({ name: 'stdio-test', version: '1' }); await client.connect(transport)
  expect((await client.listTools()).tools).toHaveLength(14)
  expect((await client.callTool({ name: 'get_asset', arguments: { assetCode: 'fixture' } })).isError).not.toBe(true)
})

it('生产stdio封装在stdin结束时关闭已有broker客户端，不依赖测试fixture补监听', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let closed = 0
  const stdio = await startAssetsMcpStdio({ scope: ctx.scope, async call() { return {} }, async close() { closed++ } }, { input, output })
  try {
    input.end(); await new Promise(r => setTimeout(r, 50))
    expect(closed).toBe(1)
  } finally { await stdio.close(); input.destroy(); output.destroy() }
})

it('stdin EOF抵达宿主后晚批准零写入', async () => {
  const input = new PassThrough(), output = new PassThrough(), buffer = new ReadBuffer()
  let release!: (value: boolean) => void, entered!: () => void, cancelled = false
  const pending = new Promise<void>(r => { entered = r })
  approve = signal => { signal.addEventListener('abort', () => { cancelled = true }, { once: true }); entered(); return new Promise<boolean>(r => { release = r }) }
  const stdio = await startAssetsMcpStdio(await connectAssetsBroker({ endpoint: broker.endpoint, token: broker.token, client: 'EOF 测试' }), { input, output })
  const transport: Transport = {
    async start() { output.on('data', chunk => { buffer.append(chunk); let m; while ((m = buffer.readMessage()) !== null) transport.onmessage?.(m) }) },
    async send(message) { input.write(serializeMessage(message)) },
    async close() { input.destroy(); output.destroy(); transport.onclose?.() }
  }
  const caller = new Client({ name: 'eof-test', version: '1' })
  try {
    await caller.connect(transport)
    void caller.callTool({ name: 'create_asset', arguments: { name: 'EOF晚批准', categoryCode: 'inbox', content: 'x', confirm: true } }).catch(() => undefined)
    await pending; input.end(); await new Promise(r => setTimeout(r, 50))
    expect(cancelled).toBe(true)
    release(true); await new Promise(r => setTimeout(r, 30))
    expect(ctx.write(s => s.get<{ n: number }>('SELECT count(*) n FROM asset')!.n)).toBe(1)
  } finally { release?.(false); await caller.close(); await stdio.close() }
})
