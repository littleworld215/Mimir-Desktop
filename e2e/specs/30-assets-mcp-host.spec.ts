import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { launchApp } from '../fixtures/launch'

const packaged = process.env.MIMIR_MCP_PACKAGE_EXE
const cli = packaged ? join(dirname(packaged), 'resources/app.asar/out/main/assetsMcpCli.js') : fileURLToPath(new URL('../../out/main/assetsMcpCli.js', import.meta.url))
const command = packaged ?? process.execPath
const cliEnv = { SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, ComSpec: process.env.ComSpec!, ...(packaged ? {ELECTRON_RUN_AS_NODE: '1'} : {}) }
test('桌面默认不开MCP；缺发现凭据的生产CLI拒绝，stderr不回显路径', async () => {
  const launched = await launchApp({ executablePath: packaged })
  const path = join(launched.paths.userData, 'assets-mcp/session.json')
  const transport = new StdioClientTransport({ command, args: [cli, '--discovery', path], stderr: 'pipe', env: cliEnv })
  let errors = ''; transport.stderr?.on('data', data => { errors += data.toString() })
  const client = new Client({ name: 'disabled-probe', version: '1' })
  try {
    expect(existsSync(path)).toBe(false)
    await expect(client.connect(transport)).rejects.toThrow()
    await expect.poll(() => errors).toContain('APP_NOT_RUNNING')
    expect(errors).not.toContain(launched.paths.userData)
  } finally { await client.close(); await launched.cleanup() }
})

test('真实Electron生产发现/CLI/SQLite闭环：默认拒绝、单次批准、原文一致、退出断连清凭据', async () => {
  const launched = await launchApp({ executablePath: packaged, extraArgs: ['--assets-mcp'] })
  const path = join(launched.paths.userData, 'assets-mcp/session.json')
  const transport = new StdioClientTransport({ command, args: [cli, '--discovery', path, '--client', '生产闭环探针'], stderr: 'pipe', env: cliEnv })
  const client = new Client({ name: 'production-probe', version: '1' })
  let errors = ''; transport.stderr?.on('data', data => { errors += data.toString() })
  try {
    await expect.poll(() => existsSync(path)).toBe(true)
    await launched.app.evaluate(({ dialog }) => {
      const state = globalThis as any
      state.mcpAllow = false; state.mcpDialogs = []
      // 自动测试替身：验证真实main选用专门原生通道，不宣称实际用户点击已验收。
      dialog.showMessageBox = (async (parent: any, options: any) => {
        state.mcpDialogs.push({ owned: !!parent && !parent.isDestroyed(), defaultId: options.defaultId, cancelId: options.cancelId, buttons: options.buttons, detail: options.detail, signal: !!options.signal })
        return { response: state.mcpAllow ? 1 : 0, checkboxChecked: false }
      }) as any
    })
    await client.connect(transport)
    expect((await client.listTools()).tools).toHaveLength(14)
    const args = { name: 'MCP批准原文', categoryCode: 'inbox', content: ' 原文\r\n\n保留 apiKey token 字样', confirm: true }
    const denied = await client.callTool({ name: 'create_asset', arguments: args })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('APPROVAL_DENIED')
    const total = await launched.page.evaluate(async () => {
      const api = window.electronAPI!.assets, context = await api.context()
      if (!context.ok) throw Error('context')
      const result = await api.list({ ...context.context })
      if (!result.ok) throw Error('search')
      return result.page.total
    })
    expect(total).toBe(0)
    await launched.app.evaluate(() => { (globalThis as any).mcpAllow = true })
    const created = await client.callTool({ name: 'create_asset', arguments: args })
    expect(created.isError).not.toBe(true)
    const code = (created.structuredContent as any).data.assetCode
    const read = await client.callTool({ name: 'get_asset', arguments: { assetCode: code } })
    expect((read.structuredContent as any).data.content.content).toBe(args.content)
    const draftText = '完整草稿正文\n\n二次确认后才采纳'
    const saved = await client.callTool({ name: 'save_ai_draft', arguments: { assetCode: code, mode: 'polish', content: draftText, confirm: true } })
    expect(saved.isError).not.toBe(true)
    const draftId = (saved.structuredContent as any).data.draftId
    const adopted = await client.callTool({ name: 'adopt_ai_draft', arguments: { draftId, confirm: true } })
    expect(adopted.isError).not.toBe(true)
    expect((await client.callTool({ name: 'get_asset', arguments: { assetCode: code } })).structuredContent).toMatchObject({ data: { content: { content: draftText }, version: 2 } })
    const dialogs = await launched.app.evaluate(() => (globalThis as any).mcpDialogs)
    expect(dialogs).toHaveLength(4)
    expect(dialogs[1]).toMatchObject({ owned: true, defaultId: 0, cancelId: 0, buttons: ['拒绝', '允许这一次'], signal: true })
    expect(dialogs[1].detail).toContain(JSON.stringify(args, null, 2))
    expect(dialogs[3].detail).toContain(JSON.stringify(draftText))
    // 正常退出走before-quit，而非测试fixture强制杀进程。
    const exit = new Promise(resolve => launched.app.process().once('exit', resolve))
    const closed = new Promise(resolve => { client.onclose = resolve })
    await launched.app.evaluate(({ app }) => app.quit())
    await exit; await closed
    expect(existsSync(path)).toBe(false)
    expect(errors).toBe('')
  } finally { await client.close(); await launched.cleanup() }
})
