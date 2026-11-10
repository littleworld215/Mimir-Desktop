import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { seedResearch } from '../fixtures/libraryResearch'
import { gotoModule, gotoResearchWritingMaterials } from '../helpers/nav'

for (const state of ['入口仍在', '面板已恢复', '动作前切换', '节点复用后点击'] as const) {
  test(`研究导航：${state}时进入写作素材，不改变正式资料`, async () => {
    let root = ''
    const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => {
      const fixture = seedResearch(seed)
      root = fixture.root
      return fixture.seed
    } })
    try {
      const { page } = ctx
      const files = ['research.json', 'evidence.json'].map(name => join(root, '.mimir/library', name))
      const before = files.map(file => readFileSync(file))
      await gotoModule(page, 'library')
      await page.getByTitle('合成研究课题', { exact: true }).click()
      const entry = page.getByRole('button', { name: '研究问题与写作素材', exact: true })
      const writing = page.getByRole('button', { name: '写作素材', exact: true })
      let transitions = 0
      if (state === '面板已恢复') await entry.click()
      if (state === '动作前切换') {
        // 在真实点击的动作检查处切换面板，固定复现恢复早于旧入口点击的时序。
        await page.addLocatorHandler(entry, async () => {
          transitions++
          await entry.click()
          await expect(writing).toBeVisible()
        }, { times: 1 })
      }
      if (state === '节点复用后点击') {
        await entry.evaluate(element => element.addEventListener('pointerdown', () => {
          const button = element as HTMLButtonElement
          button.setAttribute('data-navigation-interleaving', '1')
          button.click()
        }, { once: true }))
      }
      await gotoResearchWritingMaterials(page)
      await expect(page.getByRole('button', { name: '新建素材包', exact: true })).toBeVisible()
      if (state === '动作前切换') expect(transitions).toBe(1)
      if (state === '节点复用后点击') expect(await page.locator('[data-navigation-interleaving]').getAttribute('data-navigation-interleaving')).toBe('1')
      for (const [index, file] of files.entries()) expect(readFileSync(file)).toEqual(before[index])
    } finally { await ctx.cleanup() }
  })
}
