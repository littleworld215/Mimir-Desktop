import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test('手动文件健康检查：无版本明确报告、无摘要基准、主题窄窗与关闭焦点', async ({}, info) => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    await gotoModule(ctx.page, 'assets')
    await ctx.page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      const result = await api.create({ ...scope.context, input: { name: '合成健康检查文件', category: 'inbox', storageType: 'file' } })
      if (!result.ok) throw Error(result.message)
    })
    await ctx.page.getByRole('button', { name: '刷新', exact: true }).click()
    const trigger = ctx.page.getByRole('button', { name: '文件健康检查', exact: true })
    await expect(trigger).toBeVisible({ timeout: 7000 })
    await trigger.click()
    const dialog = ctx.page.getByRole('dialog', { name: '资产文件健康报告', exact: true })
    await expect(dialog.getByRole('button', { name: '开始检查', exact: true })).toBeEnabled()
    await expect(dialog.getByText('尚未开始检查。', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '开始检查', exact: true }).click()
    await expect(dialog.getByText('检查完成', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('cell', { name: '尚无文件版本', exact: true })).toBeVisible()
    await expect(dialog.getByText(/摘要基准：未建立/)).toBeVisible()
    await expect(dialog.getByText(/在线检查时点/)).toBeVisible()
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 760))
    await ctx.page.evaluate(() => document.documentElement.classList.add('dark'))
    const contrast = await dialog.getByRole('button', { name: '关闭报告', exact: true }).evaluate(element => {
      const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255)
      const light = (values: number[]) => values.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0)
      const text = light(rgb(getComputedStyle(element).color)), background = light(rgb(getComputedStyle(element.closest('[role=dialog]')!).backgroundColor))
      return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    await ctx.page.screenshot({ path: info.outputPath('file-health-narrow-dark.png') })
    const box = await dialog.boundingBox(), viewport = ctx.page.viewportSize()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    if (viewport) expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
    await dialog.getByRole('button', { name: '关闭报告', exact: true }).click()
    await expect(trigger).toBeFocused()
    const list = await ctx.page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      return api.list(scope.context)
    })
    expect(list.ok && list.page.total).toBe(1)
  } finally { await ctx.cleanup() }
})

test('真实文件历史和归档可检查且不记使用，非主窗口拒绝健康接口', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    await gotoModule(ctx.page, 'assets')
    const input = join(ctx.tempHome.root, 'health-original.txt')
    writeFileSync(input, '仅合成资料\r\n')
    await ctx.app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, input)
    const before = await ctx.page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      let a = await api.create({ ...scope.context, input: { name: '真实文件合成归档', category: 'inbox', storageType: 'file' } })
      if (!a.ok) throw Error(a.message)
      const selected = await window.electronAPI!.showOpenDialog({ properties: ['openFile'] }) as { filePaths: string[] }
      for (let n = 0; n < 2; n++) {
        const imported = await api.importFile({ ...scope.context, assetId: a.asset.id, expectedRevision: a.asset.revision, sourcePath: selected.filePaths[0] })
        if (!imported.ok) throw Error(imported.message)
        a = imported
      }
      const archived = await api.archive({ ...scope.context, assetId: a.asset.id, expectedRevision: a.asset.revision })
      if (!archived.ok) throw Error(archived.message)
      return { scope: scope.context, asset: archived.asset }
    })
    await ctx.page.getByRole('button', { name: '文件健康检查', exact: true }).click()
    const report = ctx.page.getByRole('dialog', { name: '资产文件健康报告', exact: true })
    await report.getByRole('button', { name: '开始检查', exact: true }).click()
    await expect(report.getByText('检查完成', { exact: true })).toBeVisible()
    await expect(report.getByRole('cell', { name: '可打开（内容未校验）', exact: true })).toHaveCount(2)
    await expect(report.getByText(/已归档/)).toHaveCount(2)
    await report.getByRole('button', { name: '关闭报告', exact: true }).click()
    const after = await ctx.page.evaluate(async before => window.electronAPI!.assets.get({ ...before.scope, assetId: before.asset.id }), before)
    expect(after).toEqual({ ok: true, asset: before.asset })
    const denied = await ctx.app.evaluate(async ({ BrowserWindow }, scope) => {
      const main = BrowserWindow.getAllWindows()[0]!
      const path = process.getBuiltinModule('node:path'), url = process.getBuiltinModule('node:url')
      const preload = path.join(path.dirname(url.fileURLToPath(main.webContents.getURL())), '../preload/index.mjs')
      const child = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false } })
      try {
        await child.loadURL(main.webContents.getURL())
        return await child.webContents.executeJavaScript(`window.electronAPI.assets.inspectFileHealth(${JSON.stringify(scope)})`)
      } finally { child.destroy() }
    }, before.scope)
    expect(denied).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  } finally { await ctx.cleanup() }
})
