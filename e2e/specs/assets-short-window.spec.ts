import { expect, test, type Locator } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

async function receivesPointer(target: Locator): Promise<boolean> {
  return target.evaluate(element => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return !!hit && (element === hit || element.contains(hit))
  })
}

for (const viewport of [{ name: 'wide-short', width: 1126, height: 609 }, { name: 'narrow', width: 850, height: 720 }]) {
  test(`资产页${viewport.name}：筛选展开后结果可点击、整页可滚动、键盘取用及主题保留`, async () => {
    const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
    try {
      const { page } = ctx
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await gotoModule(page, 'assets')
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await page.evaluate(async () => {
        const api = window.electronAPI!.assets, scope = await api.context()
        if (!scope.ok) throw Error(scope.message)
        for (const name of ['短窗资产 A', '短窗资产 B']) {
          const created = await api.create({ ...scope.context, input: { name, category: 'inbox', storageType: 'inline_text', content: '合成布局正文' } })
          if (!created.ok) throw Error(created.message)
          const archived = await api.archive({ ...scope.context, assetId: created.asset.id, expectedRevision: created.asset.revision })
          if (!archived.ok) throw Error(archived.message)
        }
      })
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await page.getByText('更多筛选', { exact: true }).click()
      const filters = page.getByRole('region', { name: '资产检索与筛选', exact: true })
      await filters.getByLabel('归档范围', { exact: true }).selectOption('only')
      const list = page.getByRole('region', { name: '资产列表', exact: true })
      const first = list.getByRole('button', { name: /短窗资产 A/ })
      await expect(first).toBeVisible()
      await first.scrollIntoViewIfNeeded()
      await expect.poll(() => receivesPointer(first), { timeout: 5000 }).toBe(true)
      await first.click()
      const detail = page.getByRole('article', { name: '资产详情', exact: true })
      await expect(detail.getByRole('heading', { name: '短窗资产 A', exact: true })).toBeVisible()
      if (viewport.width < 1024) await detail.getByRole('button', { name: '返回列表', exact: true }).click()
      const root = page.getByRole('heading', { name: '资产库', exact: true }).locator('..').locator('..')
      await root.evaluate(element => { element.scrollTop = 0 })
      const box = (await root.boundingBox())!
      await page.mouse.move(box.x + box.width - 24, box.y + Math.min(200, box.height / 2))
      await page.mouse.wheel(0, 2000)
      await expect.poll(() => root.evaluate(element => element.scrollTop), { timeout: 5000 }).toBeGreaterThan(0)
      const second = list.getByRole('button', { name: /短窗资产 B/ })
      await second.scrollIntoViewIfNeeded()
      await expect.poll(() => receivesPointer(second), { timeout: 5000 }).toBe(true)
      await second.focus()
      await expect(second).toBeFocused()
      await second.press('Enter')
      await expect(detail.getByRole('heading', { name: '短窗资产 B', exact: true })).toBeVisible()
      await expect(filters.getByLabel('归档范围', { exact: true })).toHaveValue('only')
      expect(await page.getByText('更多筛选', { exact: true }).locator('..').evaluate(element => (element as HTMLDetailsElement).open)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await detail.getByRole('heading', { name: '短窗资产 B', exact: true }).scrollIntoViewIfNeeded()
      const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false)
      await page.screenshot({ path: test.info().outputPath(`${viewport.name}-light.png`), animations: 'disabled' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(lightBackground)
      await expect(detail.getByRole('heading', { name: '短窗资产 B', exact: true })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`${viewport.name}-dark.png`), animations: 'disabled' })
    } finally { await ctx.cleanup() }
  })
}

test('资产页wide-short：满页结果与翻页按钮保持真实可达', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    const { page } = ctx
    await page.setViewportSize({ width: 1126, height: 609 })
    await gotoModule(page, 'assets')
    await page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context()
      if (!scope.ok) throw Error(scope.message)
      for (let index = 0; index < 35; index++) {
        const created = await api.create({ ...scope.context, input: { name: '满页合成资产 ' + String(index).padStart(2, '0'), category: 'inbox', storageType: 'inline_text', content: '合成分页正文' } })
        if (!created.ok) throw Error(created.message)
      }
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByText('更多筛选', { exact: true }).click()
    const list = page.getByRole('region', { name: '资产列表', exact: true })
    await expect(list).toContainText('共 35 条资产')
    const rows = list.getByRole('button', { name: /满页合成资产/ })
    const firstName = await rows.first().textContent()
    await expect(rows).toHaveCount(30)
    await rows.last().scrollIntoViewIfNeeded()
    await expect.poll(() => receivesPointer(rows.last())).toBe(true)
    await rows.last().click()
    const next = list.getByRole('button', { name: '下一页', exact: true })
    await next.scrollIntoViewIfNeeded()
    await expect.poll(() => receivesPointer(next)).toBe(true)
    await next.click()
    await expect(rows).toHaveCount(5)
    await expect(next).toBeDisabled()
    await rows.last().scrollIntoViewIfNeeded()
    await expect.poll(() => receivesPointer(rows.last())).toBe(true)
    await rows.last().click()
    const previous = list.getByRole('button', { name: '上一页', exact: true })
    await previous.scrollIntoViewIfNeeded()
    await previous.focus()
    await previous.press('Enter')
    await expect(rows).toHaveCount(30)
    await expect(rows.first()).toHaveText(firstName!)
    expect(await page.getByText('更多筛选', { exact: true }).locator('..').evaluate(element => (element as HTMLDetailsElement).open)).toBe(true)
  } finally { await ctx.cleanup() }
})
