import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('剪贴板静默拒绝：实际旧内容不能冒充成功、不记使用、不关闭或自动重试', async () => {
  const launched = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  const { app, page } = launched
  try {
    await gotoModule(page, 'assets')
    const id = await page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      const created = await api.create({ ...scope.context, input: { name: '核验合成资产', category: 'inbox', storageType: 'external_link', externalUrl: 'https://example.org/synthetic' } })
      if (!created.ok) throw Error(created.message)
      const favorite = await api.setFavorite({ ...scope.context, assetId: created.asset.id, favorite: true })
      if (!favorite.ok) throw Error(favorite.message)
      return created.asset.id
    })
    await app.evaluate(({ clipboard }) => clipboard.writeText('合成旧内容'))
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('合成旧内容')
    // Only simulate a write that falsely resolves. Read the real native clipboard.
    await page.evaluate(() => {
      let writes = 0
      navigator.clipboard.writeText = async () => { ++writes }
      Object.defineProperty(window, '__copyAttempts', { get: () => writes })
    })
    await page.getByRole('button', { name: '快速取用（Ctrl/Cmd+Shift+K）' }).click()
    await page.getByRole('button', { name: '核验合成资产 · external_link', exact: true }).click()
    await page.getByRole('button', { name: '复制并关闭' }).click()
    await expect(page.getByRole('alert')).toContainText('未能确认剪贴板内容，请重试。')
    await expect(page.getByLabel('快速取用详情')).toContainText('https://example.org/synthetic')
    await expect(page.getByRole('status').filter({ hasText: '取用成功' })).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __copyAttempts: number }).__copyAttempts)).toBe(1)
    const detail = await page.evaluate(async assetId => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      return api.get({ ...scope.context, assetId })
    }, id)
    expect(detail).toMatchObject({ ok: true, asset: { lastUsedAt: null } })
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('合成旧内容')
  } finally { await launched.cleanup() }
})
