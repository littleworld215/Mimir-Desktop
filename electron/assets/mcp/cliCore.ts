/** CLI只读用户凭据并连接桌面；没有数据库、Electron和模型依赖。 */
import { isAbsolute } from 'node:path'
import { readDiscovery } from './discovery'
import { BrokerError, connectAssetsBroker } from './localTransport'
import { startAssetsMcpStdio } from './sdk'

export function parseCliArgs(args: string[]): { discovery: string; client: string } {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!['--discovery', '--client'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new BrokerError('BAD_REQUEST')
    values.set(key, value)
  }
  const discovery = values.get('--discovery'), client = values.get('--client') ?? '外部 MCP 客户端'
  if (!discovery || !isAbsolute(discovery) || discovery.includes('\u0000') || !client.trim() || client.length > 80 || /[\u0000-\u001f\u007f]/.test(client)) throw new BrokerError('BAD_REQUEST')
  return { discovery, client }
}
export async function runAssetsMcpCli(args: string[]) {
  const options = parseCliArgs(args)
  const discovery = await readDiscovery(options.discovery)
  const client = await connectAssetsBroker({ ...discovery, client: options.client, keepAliveMs: 60000 })
  try {
    const server = await startAssetsMcpStdio(client)
    void client.closed?.then(() => server.close()).catch(() => {})
    return server
  } catch (error) { await client.close(); throw error }
}
