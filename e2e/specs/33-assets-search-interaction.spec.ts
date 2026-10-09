import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('真实Electron检索码点边界与快速输入后立即Enter', async () => {
  const launched = await launchApp()
  const { page } = launched
  try {
    await gotoModule(page, 'assets')
    await page.evaluate(async () => {
      const api = window.electronAPI!.assets, c = await api.context()
      if (!c.ok) throw Error(c.message)
      for (const name of ['原列表资料', '精准目标资料']) {
        const a = await api.create({ ...c.context, input: { name, category: 'inbox', storageType: 'inline_text', content: name + '正文' } })
        if (!a.ok) throw Error(a.message)
        const f = await api.setFavorite({ ...c.context, assetId: a.asset.id, favorite: true })
        if (!f.ok) throw Error(f.message)
      }
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const input = page.getByLabel('检索资产', { exact: true })
    await input.fill('a'.repeat(201))
    await input.press('Enter')
    await expect(page.getByRole('alert')).toContainText('200')
    await expect(input).toHaveValue('a'.repeat(201))
    await input.fill('😀'.repeat(201))
    await input.press('Enter')
    await expect(input).toHaveValue('😀'.repeat(201))
    await expect(page.getByRole('alert')).toContainText('200')
    await input.fill(' ' + '😀'.repeat(200) + ' ')
    await input.press('Enter')
    // Successful submission keeps existing outer-whitespace normalization, without losing a code point.
    await expect(input).toHaveValue('😀'.repeat(200))
    await expect(page.getByLabel('资产列表')).toContainText('共 0 条资产')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: '快速取用（Ctrl/Cmd+Shift+K）' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: '原列表资料 · inline_text', exact: true })).toBeEnabled()
    // One renderer turn: do not accidentally wait for the 300ms debounce between typing and Enter.
    await page.getByLabel('快速检索').evaluate(node => {
      const input = node as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '精准目标')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await expect(dialog.getByRole('heading', { name: '精准目标资料', exact: true })).toBeVisible()
    await expect(dialog.getByLabel('快速取用详情')).toContainText('精准目标资料正文')
    await expect(dialog.getByLabel('快速取用详情')).not.toContainText('原列表资料正文')
    await page.keyboard.press('Escape')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  } finally { await launched.cleanup() }
})
