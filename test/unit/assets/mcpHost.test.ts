import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import { startAssetsMcpHost } from '../../../electron/assets/mcp/host'
import { readDiscovery } from '../../../electron/assets/mcp/discovery'
import { connectAssetsBroker } from '../../../electron/assets/mcp/localTransport'
import { parseCliArgs } from '../../../electron/assets/mcp/cliCore'
import { searchAssets } from '../../../electron/assets/searchService'

const root = mkdtempSync(join(tmpdir(), 'assets-host-'))
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('生产宿主复用唯一SQLite；拒绝零写、批准创建、切换旧连接失效、关闭撤销发现', async () => {
  const data = join(root, 'profile'); mkdirSync(root, { recursive: true }); mkdirSync(data)
  let epoch = 'A#1', allow = false
  const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => epoch }, (p, o) => new Database(p, o))
  const host = await startAssetsMcpHost({ userData: data, currentScope: () => manager.context(), context: scope => manager.getForRequest(scope), approve: async () => allow })
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
