/** 独立构建入口，stdout只供官方SDK；不接收token参数，不开启新桌面/数据库。 */
import { runAssetsMcpCli } from './cliCore'
import { safeBrokerError } from './localTransport'

void runAssetsMcpCli(process.argv.slice(2)).then(server => {
  const stop = () => { void server.close().finally(() => { process.stdin.pause() }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}).catch(error => {
  const safe = safeBrokerError(error)
  process.stderr.write(`Mimir MCP: ${safe.code} ${safe.message}\n`)
  process.exitCode = 1
})
