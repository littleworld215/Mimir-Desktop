/** 构建后真实SDK子进程探针；宿主为测试接缝，不证明真实Electron批准或SQLite写入。 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('./fixtures/assetsMcpStdio.mjs', import.meta.url))], stderr: 'pipe',
  // Windows受管环境需要这些非凭据系统变量；不传模型key/token/代理或完整process.env。
  env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    WINDIR: process.env.WINDIR ?? 'C:\\Windows', ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    ...(process.env.ELECTRON_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } : {} })
const client = new Client({ name: 'assets-stdio-probe', version: '1' })
let stderr = ''
transport.stderr?.on('data', data => { stderr += data.toString() })
try {
  await client.connect(transport)
  assert.equal((await client.listTools()).tools.length, 14)
  assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 3)
  assert.equal((await client.listPrompts()).prompts.length, 2)
  const result = await client.callTool({ name: 'get_asset', arguments: { assetCode: 'fixture' } })
  assert.equal(result.structuredContent.data.content.content, ' 原文 apiKey token\r\n\n')
  console.log('[assets-mcp-stdio] 4/4 PASS (real SDK child process; fake host)')
} finally {
  await client.close()
  if (stderr) process.stderr.write(stderr)
}
