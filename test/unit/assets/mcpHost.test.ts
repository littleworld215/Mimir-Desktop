import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as native from '../../../electron/assets/mcp/windowsPipeRelay'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { startAssetsMcpHost } from '../../../electron/assets/mcp/host'
import { readDiscovery } from '../../../electron/assets/mcp/discovery'
import { connectAssetsBroker } from '../../../electron/assets/mcp/localTransport'
import { parseCliArgs } from '../../../electron/assets/mcp/cliCore'
import { searchAssets } from '../../../electron/assets/searchService'

const root = mkdtempSync(join(tmpdir(), 'assets-host-'))
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
it('生产宿主复用唯一SQLite；拒绝零写、批准创建、切换旧连接失效、关闭撤销发现', async () => {
  const data = join(root, 'profile'); mkdirSync(root, { recursive: true }); mkdirSync(data)
  let epoch = 'A#1', allow = false
  const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
  const host = await startAssetsMcpHost({ pipeArtifact: { kind: 'development' as const, appRoot: process.cwd() }, userData: data, currentScope: () => manager.context(), context: scope => manager.getForRequest(scope), approve: async () => allow })
  const client = await connectAssetsBroker({ ...await readDiscovery(host.discoveryPath), client: '真实宿主测试' })
  try {
    const args = { name: '新资产', content: ' 原文\r\n', categoryCode: 'inbox', confirm: true }
    await expect(client.call('create_asset', args)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' })
    const ctx = await manager.getForRequest(manager.context())
    expect(searchAssets(ctx, {}).total).toBe(0)
    allow = true
    await client.call('create_asset', args)
    expect(searchAssets(ctx, {}).total).toBe(1)
    epoch = 'A#2'
    await expect(client.call('list_tags', {})).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
    await host.close()
    await expect(readDiscovery(host.discoveryPath)).rejects.toMatchObject({ code: 'APP_NOT_RUNNING' })
  } finally { await client.close(); await host.close(); await manager.close() }
})
it('CLI不接收token/endpoint/env模型；参数缺省、重复、未知和相对路径拒绝', () => {
  expect(parseCliArgs(['--discovery', join(root, 'session.json'), '--client', '本机SDK'])).toEqual({ discovery: join(root, 'session.json'), client: '本机SDK' })
  for (const args of [[], ['--token', 'secret'], ['--discovery', 'relative'], ['--discovery', root, '--discovery', root], ['--discovery', root, '--client', 'bad\nclient']]) expect(() => parseCliArgs(args)).toThrow()
})
it.runIf(process.platform === 'win32')('cancel during startup closes broker without twenty-second ready wait', async () => {
  mkdirSync(root, { recursive: true })
  const abort = new AbortController()
  let entered!: () => void
  const starting = new Promise<void>(resolve => { entered = resolve })
  vi.spyOn(native, 'startWindowsPipeRelay').mockImplementationOnce(options => new Promise((_resolve, reject) => {
    entered()
    options.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }))
  const data = join(root, 'cancelled')
  mkdirSync(data)
  const pending = startAssetsMcpHost({ pipeArtifact: { kind: 'development', appRoot: process.cwd() }, signal: abort.signal,
    userData: data, currentScope: () => ({ workspaceId: 'A', spaceEpoch: 'A#1' }),
    context: async () => { throw new Error('no DB') }, approve: async () => false })
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await starting
  const at = Date.now(); abort.abort(); await rejected
  expect(Date.now() - at).toBeLessThan(3000)
  expect(existsSync(join(data, 'assets-mcp/session.json'))).toBe(false)
})
it.runIf(process.platform === 'win32')('missing helper rejects MCP without discovery or database access', async () => {
  mkdirSync(root, { recursive: true })
  const data = join(root, 'missing-helper')
  mkdirSync(data)
  await expect(startAssetsMcpHost({ pipeArtifact: { kind: 'development', appRoot: join(root, 'no-app') },
    userData: data, currentScope: () => ({ workspaceId: 'A', spaceEpoch: 'A#1' }),
    context: async () => { throw new Error('no DB') }, approve: async () => false })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(existsSync(join(data, 'assets-mcp/session.json'))).toBe(false)
})
it.runIf(process.platform === 'win32')('原生初始化失败不发布发现、不回退旧pipe', async () => {
  mkdirSync(root, { recursive: true })
  const data = join(root, 'failed'); mkdirSync(data)
  vi.spyOn(native, 'startWindowsPipeRelay').mockRejectedValueOnce(new Error('probe unavailable'))
  let host: Awaited<ReturnType<typeof startAssetsMcpHost>> | undefined
  try {
    await expect(startAssetsMcpHost({ pipeArtifact: { kind: 'development' as const, appRoot: process.cwd() }, userData: data, currentScope: () => ({ workspaceId: 'A', spaceEpoch: 'A#1' }), context: async () => { throw new Error('no DB allowed') }, approve: async () => false }).then(h => { host = h; return h })).rejects.toThrow('probe unavailable')
    expect(existsSync(join(data, 'assets-mcp', 'session.json'))).toBe(false)
  } finally { await host?.close() }
})
it.runIf(process.platform === 'win32')('helper确认中异常退出撤销发现、取消批准、真实SQLite零写', async () => {
  mkdirSync(root, { recursive: true })
  const data = join(root, 'death'); mkdirSync(data)
  const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  let relay: native.WindowsPipeRelay | undefined, aborted = false
  const original = native.startWindowsPipeRelay
  vi.spyOn(native, 'startWindowsPipeRelay').mockImplementationOnce(async options => { relay = await original(options); return relay })
  let entered!: () => void
  const confirming = new Promise<void>(r => { entered = r })
  const host = await startAssetsMcpHost({ pipeArtifact: { kind: 'development' as const, appRoot: process.cwd() }, userData: data, currentScope: () => manager.context(), context: scope => manager.getForRequest(scope), approve: request => new Promise<boolean>(r => {
    entered(); request.signal.addEventListener('abort', () => { aborted = true; r(false) }, {once: true})
  }) })
  const client = await connectAssetsBroker({ ...await readDiscovery(host.discoveryPath), client: '异常退出探针' })
  try {
    const call = client.call('create_asset', { name: '不应写入', categoryCode: 'inbox', content: 'secret body', confirm: true })
    const rejected = expect(call).rejects.toMatchObject({code: 'DISCONNECTED'})
    await confirming
    expect(relay).toBeDefined()
    process.kill(relay!.pid)
    await rejected
    // Discovery ownership revalidation runs two bounded (10s each) Windows ACL probes.
    const cleanupDeadline = Date.now() + 25_000
    while (existsSync(host.discoveryPath) && Date.now() < cleanupDeadline) await new Promise(r => setTimeout(r, 50))
    expect(existsSync(host.discoveryPath)).toBe(false)
    expect(aborted).toBe(true)
    const ctx = await manager.getForRequest(manager.context())
    expect(searchAssets(ctx, {}).total).toBe(0)
  } finally { await client.close(); await host.close(); await manager.close() }
})
