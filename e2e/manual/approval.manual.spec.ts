import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { launchApp } from '../fixtures/launch'
import { finishManualApproval, fitManualApprovalBody, manualApprovalBody, MANUAL_MARKERS } from '../helpers/manualApprovalPlan'

interface Observation { bytes: number; markers: boolean[]; response?: number }
interface NativeState { manualApprovalEvents: Observation[] }

test('真实 Windows 原生批准：人工按钮操作与长文阅读（合成资料）', async ({}, info) => {
  const observations: Observation[] = []
  const cases: { action: string; response: number | undefined; total: number; bytes?: number }[] = []
  const report = { status: 'running', humanActionAttested: false, readability: 'pending-user-report', cases, observations, temporaryHomeRemoved: false, discoveryRemoved: false }
  const save = () => writeFileSync(info.outputPath('manual-result.json'), JSON.stringify(report, null, 2))
  const packaged = process.env.MIMIR_E2E_PACKAGED
  const launched = await launchApp({ nativeMessageBoxes: true, extraArgs: ['--assets-mcp'], executablePath: packaged })
  const discovery = join(launched.paths.userData, 'assets-mcp/session.json')
  const cli = packaged ? join(dirname(packaged), 'resources/app.asar/out/main/assetsMcpCli.js') : fileURLToPath(new URL('../../out/main/assetsMcpCli.js', import.meta.url))
  const client = new Client({ name: 'manual-approval', version: '1' })
  let originalError: unknown
  try {
    save()
    await launched.app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as NativeState
      state.manualApprovalEvents = []
      const original = dialog.showMessageBox
      // Observe only. Forward every argument (including parent/signal) and the real response.
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args[args.length - 1] as { title?: string; detail?: string }
        const event = options.title === '外部客户端请求写入科研资产'
          ? { bytes: Buffer.byteLength(options.detail ?? '', 'utf8'), markers: ['[合成开头-BEGIN]', '[合成中间-MIDDLE]', '[合成末尾-END]'].map(marker => (options.detail ?? '').includes(marker)) } as Observation : undefined
        if (event) state.manualApprovalEvents.push(event)
        const result = await Reflect.apply(original, dialog, args)
        if (event) event.response = result.response
        return result
      }) as typeof dialog.showMessageBox
    })
    await expect.poll(() => existsSync(discovery)).toBe(true)
    await client.connect(new StdioClientTransport({ command: packaged ?? process.execPath,
      args: [cli, '--discovery', discovery, '--client', '人工原生验收'], stderr: 'ignore',
      env: { SystemRoot: process.env.SystemRoot!, WINDIR: process.env.WINDIR!, ComSpec: process.env.ComSpec!, ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }))
    expect((await client.listTools()).tools).toHaveLength(14)
    const total = () => launched.page.evaluate(async () => {
      const api = window.electronAPI!.assets, context = await api.context()
      if (!context.ok) throw Error('临时空间不可用')
      const result = await api.list({ ...context.context })
      if (!result.ok) throw Error('临时清单不可用')
      return result.page.total
    })
    expect(await total()).toBe(0)
    let baseline = 0
    const actions = ['按 Enter（默认拒绝）', '按 Esc（拒绝）', '点击“拒绝”', '点击“允许这一次”', '再次相同请求，点击“拒绝”', '检查长文三个标记、中文与长行均可读，随后点击“拒绝”', '超过上限：应无弹窗']
    for (let i = 0; i < actions.length; i++) {
      console.log(`\n人工步骤 ${i + 1}/7：${actions[i]}。单次批准最多两分钟，不延长产品时限。`)
      const content = i >= 5 ? fitManualApprovalBody(baseline, i === 5 ? 48_000 : 48_001) : manualApprovalBody()
      const result = await client.callTool({ name: 'create_asset', arguments: { name: '人工合成资料', categoryCode: 'inbox', content, confirm: true } }, undefined, { timeout: 125_000 })
      const current = await launched.app.evaluate(() => (globalThis as unknown as NativeState).manualApprovalEvents)
      observations.splice(0, observations.length, ...current)
      const event = i === 6 ? undefined : current[current.length - 1]
      cases.push({ action: actions[i], response: event?.response, bytes: event?.bytes, total: await total() })
      save()
      expect(current).toHaveLength(Math.min(i + 1, 6))
      if (i === 0) baseline = event!.bytes
      if (i === 5) { expect(event!.bytes).toBe(48_000); expect(event!.markers).toEqual(MANUAL_MARKERS.map(() => true)) }
      if (i === 3) {
        expect(event!.response).toBe(1)
        expect(result.isError).not.toBe(true)
        const data = (result.structuredContent as { data?: { assetCode?: unknown } } | undefined)?.data
        expect(typeof data?.assetCode).toBe('string')
        const read = await client.callTool({ name: 'get_asset', arguments: { assetCode: data!.assetCode } })
        expect(read.structuredContent).toMatchObject({ data: { content: { content } } })
      } else {
        if (event) expect(event.response).toBe(0)
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toMatchObject({ error: { code: 'APPROVAL_DENIED' } })
      }
      expect(cases[i].total).toBe(i < 3 ? 0 : 1)
    }
    report.status = 'objective-checks-passed-human-report-pending'
  } catch (error) {
    report.status = 'failed-or-interrupted'
    originalError = error
  } finally {
    // A disk/report failure must never bypass disposal of our own client and app.
    await finishManualApproval([save, () => client.close(), () => launched.cleanup(), () => {
      report.temporaryHomeRemoved = !existsSync(launched.tempHome.root)
      report.discoveryRemoved = !existsSync(discovery)
      save()
    }], originalError)
    expect(report.temporaryHomeRemoved).toBe(true)
    expect(report.discoveryRemoved).toBe(true)
  }
})
