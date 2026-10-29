import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('资产操作层级：键盘先取用、原删除确认可取消、三类资产与窄窗不溢出', async ({}, testInfo) => {
  const launched = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  const { page, app } = launched
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900))
    await gotoModule(page, 'assets')
    const ids = await page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      const ids: number[] = []
      for (const input of [
        { name: '布局验证文本', category: 'inbox', storageType: 'inline_text' as const, content: ' 合成正文\n\n' },
        { name: '布局验证链接', category: 'inbox', storageType: 'external_link' as const, externalUrl: 'https://example.org/layout' },
        { name: '布局验证文件', category: 'inbox', storageType: 'file' as const }
      ]) {
        const result = await api.create({ ...scope.context, input })
        if (!result.ok) throw Error(result.message)
        ids.push(result.asset.id)
      }
      return ids
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByLabel('资产列表').getByRole('button', { name: /布局验证文本/ }).click()
    const detail = page.getByRole('article', { name: '资产详情' })
    await expect(detail.getByRole('button', { name: '复制正文', exact: true })).toBeEnabled()
    await detail.getByRole('button', { name: '收藏资产', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(detail.getByRole('button', { name: '复制正文', exact: true })).toBeFocused()

    const toolbar = page.getByRole('region', { name: '资产操作' })
    const common = toolbar.getByRole('group', { name: '常用取用' })
    const management = toolbar.getByRole('group', { name: '资料管理' })
    const batch = toolbar.getByRole('group', { name: '批量整理' })
    for (const name of ['新建资产', '快速取用（Ctrl/Cmd+Shift+K）', '刷新']) await expect(common.getByRole('button', { name, exact: true })).toBeVisible()
    for (const name of ['标签管理', '保存筛选', '导入JSON', '导入文件夹', '导出', '使用指南']) await expect(management.getByRole('button', { name, exact: true })).toBeVisible()
    for (const name of ['选择／取消当前页', '清空选择', '批量整理', '组合任务包']) await expect(batch.getByRole('button', { name, exact: true })).toBeVisible()
    const desktopTops = await toolbar.getByRole('group').evaluateAll(groups => groups.map(group => group.getBoundingClientRect().top))
    expect(Math.max(...desktopTops) - Math.min(...desktopTops)).toBeLessThanOrEqual(1)
    async function assertGroupBounds() {
      const bounds = await toolbar.getByRole('group').evaluateAll(groups => groups.map(group => {
        const outer = group.getBoundingClientRect()
        return { left: outer.left, right: outer.right, buttons: [...group.querySelectorAll('button')].map(button => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })) }
      }))
      for (const group of bounds) for (const button of group.buttons) {
        expect(button.left).toBeGreaterThanOrEqual(group.left - 1)
        expect(button.right).toBeLessThanOrEqual(group.right + 1)
      }
    }
    await assertGroupBounds()
    await expect(batch.getByRole('button', { name: '批量整理', exact: true })).toBeDisabled()
    await batch.getByRole('button', { name: '选择／取消当前页', exact: true }).click()
    await expect(batch).toContainText('已选 3 / 500')
    await expect(batch.getByRole('button', { name: '批量整理', exact: true })).toBeEnabled()
    await batch.getByRole('button', { name: '清空选择', exact: true }).click()
    await expect(batch.getByRole('button', { name: '组合任务包', exact: true })).toBeDisabled()
    await toolbar.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('action-layout-light.png') })

    const danger = detail.getByRole('region', { name: '危险操作' })
    await danger.getByRole('button', { name: '永久删除', exact: true }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '永久删除资产', exact: true })
    await expect(dialog.getByLabel('我确认删除上述资产及历史')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '永久删除', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(danger.getByRole('button', { name: '永久删除', exact: true })).toBeFocused()
    const retained = await page.evaluate(async assetId => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      return api.get({ ...scope.context, assetId })
    }, ids[0])
    expect(retained).toMatchObject({ ok: true, asset: { currentContent: ' 合成正文\n\n', versionCount: 1 } })

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 760))
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await detail.getByRole('heading', { name: '布局验证文本', exact: true }).scrollIntoViewIfNeeded()
    await toolbar.scrollIntoViewIfNeeded()
    await assertGroupBounds()
    const layout = await toolbar.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return { viewport: innerWidth, page: document.documentElement.scrollWidth, right: bounds.right, left: bounds.left, buttons: [...element.querySelectorAll('button')].map(button => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })) }
    })
    expect(layout.page).toBeLessThanOrEqual(layout.viewport + 1)
    for (const bounds of layout.buttons) {
      expect(bounds.left).toBeGreaterThanOrEqual(layout.left - 1)
      expect(bounds.right).toBeLessThanOrEqual(layout.right + 1)
    }
    await page.screenshot({ path: testInfo.outputPath('action-layout-narrow-dark.png') })
    await danger.screenshot({ path: testInfo.outputPath('danger-area-dark.png') })
    await detail.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.getByLabel('资产列表').getByRole('button', { name: /布局验证文件/ }).click()
    await expect(detail.getByRole('region', { name: '阅读与取用' }).getByRole('button', { name: '下载当前文件', exact: true })).toBeDisabled()
    await expect(detail.getByRole('region', { name: '管理与历史' }).getByRole('button', { name: '导入新文件版本', exact: true })).toBeEnabled()
    await detail.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.getByLabel('资产列表').getByRole('button', { name: /布局验证链接/ }).click()
    const use = detail.getByRole('region', { name: '阅读与取用' })
    await expect(use.getByRole('button', { name: '复制外链', exact: true })).toBeEnabled()
    await expect(use.getByRole('button', { name: '打开外链', exact: true })).toBeEnabled()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900))
    await page.evaluate(async () => {
      document.documentElement.classList.remove('dark')
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      const result = await api.create({ ...scope.context, input: { name: '长文布局验证', category: 'inbox', storageType: 'inline_text', content: '合成科研记录\n'.repeat(2000) + '结尾校验' } })
      if (!result.ok) throw Error(result.message)
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByLabel('资产列表').getByRole('button', { name: /长文布局验证/ }).click()
    await expect(detail.getByRole('button', { name: '复制正文', exact: true })).toBeEnabled()
    await expect(detail.getByRole('button', { name: '编辑资产', exact: true })).toBeInViewport()
    await expect(detail.getByRole('button', { name: '历史版本', exact: true })).toBeInViewport()
    await expect(detail.locator('pre').filter({ hasText: '结尾校验' })).toContainText('结尾校验')
  } finally { await launched.cleanup() }
})
