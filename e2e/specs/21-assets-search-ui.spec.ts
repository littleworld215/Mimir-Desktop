import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

const runtimes = [{ name: 'development', executablePath: undefined as string | undefined }, ...(process.env.MIMIR_E2E_PACKAGED ? [{ name: 'packaged', executablePath: resolve(process.env.MIMIR_E2E_PACKAGED) }] : [])]
for (const runtime of runtimes) test(`${runtime.name}: real search, relation UI, graph, archive and cascade`, async () => {
  const launched = await launchApp({ executablePath: runtime.executablePath })
  const page = launched.page
  try {
    await gotoModule(page, 'assets')
    await page.evaluate(async () => {
      const api = window.electronAPI!.assets, context = await api.context()
      if (!context.ok) throw new Error(context.message)
      for (const [name, content] of [['UI科研A', '短词科研\n<script>unsafe</script>'], ['UI目标B', '目标资料'], ['UI环C', '环资料']]) {
        const result = await api.create({ ...context.context, input: { name, category: 'inbox', storageType: 'inline_text', content } })
        if (!result.ok) throw new Error(result.message)
      }
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const list = page.getByRole('region', { name: '资产列表' }), detail = page.getByRole('article', { name: '资产详情' }), refs = page.getByRole('region', { name: '资产参见' })
    await page.getByLabel('检索范围').selectOption('body')
    await page.getByLabel('检索资产').fill('科研')
    await page.getByLabel('检索资产').press('Enter')
    await expect(list.getByRole('button', { name: /UI科研A/ })).toBeVisible()
    await expect(list.getByRole('button', { name: /UI目标B/ })).toHaveCount(0)
    await expect(list.locator('mark')).toContainText('科研')
    await list.getByRole('button', { name: /UI科研A/ }).click()
    await expect(detail).toContainText('<script>unsafe</script>')
    async function add(name: string) {
      await refs.getByLabel('查找关联资产').fill(name)
      await refs.getByRole('button', { name: '查找目标', exact: true }).click()
      await refs.getByRole('button', { name: `选择关联资产 ${name}`, exact: true }).click()
      await expect(refs).toContainText(`已选择：${name}`)
      await refs.getByRole('button', { name: '添加参见', exact: true }).click()
      await expect(refs.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await add('UI目标B')
    await refs.getByRole('button', { name: 'UI目标B', exact: true }).click()
    await expect(detail.getByRole('heading', { name: 'UI目标B' })).toBeVisible()
    await expect(refs).toContainText('被参见')
    await expect(refs.getByRole('button', { name: 'UI科研A', exact: true })).toBeVisible()
    await add('UI环C')
    await refs.getByRole('button', { name: 'UI环C', exact: true }).click()
    await expect(detail.getByRole('heading', { name: 'UI环C' })).toBeVisible()
    await add('UI科研A')
    await refs.getByRole('button', { name: '查看关系图' }).click()
    await expect(refs).toContainText('3 个资产 · 3 条关系')
    await refs.getByRole('group', { name: '关系图' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `../../.git/codex-integration/i2-ui-${runtime.name}-light.png` })
    await refs.getByRole('button', { name: '打开关系资产 UI科研A' }).press('Enter')
    await expect(detail.getByRole('heading', { name: 'UI科研A' })).toBeVisible()
    await detail.getByRole('button', { name: '归档资产' }).click()
    await expect(refs.getByRole('button', { name: '添加参见' })).toBeDisabled()
    await page.getByRole('button', { name: '清空筛选' }).click()
    await page.getByText('更多筛选', { exact: true }).click()
    await page.getByLabel('归档范围').selectOption('only')
    await list.getByRole('button', { name: /UI科研A/ }).click()
    await detail.getByRole('button', { name: '永久删除', exact: true }).click()
    await page.getByLabel('我确认删除上述资产及历史').check()
    await page.getByRole('dialog').getByRole('button', { name: '永久删除', exact: true }).click()
    await expect(detail).toHaveCount(0)
    await page.getByRole('button', { name: '清空筛选' }).click()
    await list.getByRole('button', { name: /UI目标B/ }).click()
    await expect(refs.getByRole('button', { name: 'UI科研A', exact: true })).toHaveCount(0)
    await page.getByText('更多筛选', { exact: true }).click()
    await page.setViewportSize({ width: 850, height: 720 })
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await expect(detail).toBeVisible()
    await expect(page.getByRole('button', { name: '返回列表' })).toBeVisible()
    await page.screenshot({ path: `../../.git/codex-integration/i2-ui-${runtime.name}-dark-narrow.png` })
  } finally { await launched.cleanup() }
})
