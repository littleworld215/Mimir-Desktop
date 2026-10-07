import { createServer } from 'node:http'
import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { withLoopbackServer } from '../fixtures/withLoopbackServer'
import { gatewayModelSeed } from '../fixtures/seed'
import { gotoModule } from '../helpers/nav'

for (const runtime of ['development', ...(process.env.MIMIR_E2E_PACKAGED ? ['packaged'] : [])]) {
  test(`I5 AI界面：确认发送、原文对照、编辑采纳、溯源、标签、取消与焦点 (${runtime})`, async () => {
    let calls = 0, delay = false
    const prompts: string[] = []
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk.toString()
      const prompt = JSON.parse(body).messages.map((m: { content: string }) => m.content).join('\n')
      calls++; prompts.push(prompt)
      if (delay) await new Promise(r => setTimeout(r, 1200))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: prompt.includes('标签助手') ? '["Rust","科研"]' : '模型结果\n\n保留空白' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }))
    })
    await withLoopbackServer(server, port => launchApp({ ...(runtime === 'packaged' ? { executablePath: process.env.MIMIR_E2E_PACKAGED } : {}), transformSeed: seed => ({ ...seed, settings: gatewayModelSeed(`http://127.0.0.1:${port}/v1`) }) }), async ({ page }) => {
      await gotoModule(page, 'assets')
      const ids = await page.evaluate(async () => {
        const api = window.electronAPI!.assets, c = await api.context(); if (!c.ok) throw Error(c.message)
        const a = await api.create({ ...c.context, input: { code: 'ai-ui-original', name: 'AI界面原文', category: 'inbox', storageType: 'inline_text', content: ' 原始正文\n\n保留空白' } })
        const p = await api.create({ ...c.context, input: { code: 'ai-ui-prompt', name: '可配置语言模板', category: 'prompt', kind: 'prompt', storageType: 'inline_text', content: '{{语言:中文}}\n{{原文}}', templateConfig: { version: 1, variables: { 语言: { type: 'single', options: ['中文', '英文'] } } } } })
        if (!a.ok || !p.ok) throw Error('seed failed')
        return { assetId: a.asset.id, promptId: p.asset.id, scope: c.context }
      })
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await page.getByLabel('资产列表').getByRole('button', { name: /AI界面原文/ }).click()
      await page.getByRole('button', { name: 'AI 整理', exact: true }).click()
      await expect(page.getByRole('button', { name: '生成待采纳草稿' })).toBeDisabled()
      expect(calls).toBe(0)
      await page.getByLabel('Prompt 模板', { exact: true }).selectOption(String(ids.promptId))
      await page.getByLabel('语言', { exact: true }).selectOption('英文')
      await page.getByLabel(/同意将原文/).check()
      await page.getByRole('button', { name: '生成待采纳草稿' }).click()
      await expect(page.getByLabel('草稿来源原文')).toHaveText(' 原始正文\n\n保留空白')
      expect(prompts[0]).toContain('英文\n 原始正文\n\n保留空白')
      await page.getByLabel('编辑后采纳正文').fill('# 人工修订\n\n结果')
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '存在未保存的资产编辑' })).toBeVisible()
      await page.getByRole('button', { name: '留在这里' }).click()
      await expect(page.getByLabel('编辑后采纳正文')).toHaveValue('# 人工修订\n\n结果')
      await page.getByLabel(/确认采纳此草稿/).check()
      await page.getByRole('button', { name: '采纳草稿' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'AI 整理', exact: true })).toBeFocused()
      const adopted = await page.evaluate(async ({ assetId, scope }) => {
        const api = window.electronAPI!.assets, a = await api.get({ ...scope, assetId }); if (!a.ok) throw Error(a.message)
        const v = await api.getVersion({ ...scope, assetId, versionId: a.asset.currentVersionId! })
        const original = await api.listVersions({ ...scope, assetId })
        return { a, v, original, drafts: await api.listAiDrafts({ ...scope }) }
      }, ids)
      expect(adopted.a).toMatchObject({ asset: { currentContent: '# 人工修订\n\n结果', currentVersion: 2 } })
      expect(adopted.v.ok && JSON.parse(adopted.v.version.sourceJson)).toMatchObject({ aiGenerated: true, edited: true })
      expect(adopted.original).toMatchObject({ page: { total: 2 } }); expect(adopted.drafts).toMatchObject({ page: { total: 0 } })
      await page.getByRole('button', { name: '历史版本', exact: true }).click()
      await page.getByRole('button', { name: '读取版本 2' }).click()
      await expect(page.getByText('AI 生成版本 · 来源与模型快照保留')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'AI 标签建议', exact: true }).click()
      expect(calls).toBe(1)
      await page.getByLabel(/同意发送正文摘要/).check()
      await page.getByRole('button', { name: '生成标签建议' }).click()
      await page.getByLabel('选择标签 Rust').check()
      await page.getByLabel(/确认添加所选标签/).check()
      await page.getByRole('button', { name: '采纳所选标签' }).click()
      await expect(page.getByLabel('资产详情')).toContainText('#Rust')
      delay = true
      await page.getByRole('button', { name: 'AI 整理', exact: true }).click()
      await page.getByLabel(/同意将原文/).check()
      await page.getByRole('button', { name: '生成待采纳草稿' }).click()
      await expect.poll(() => calls).toBe(3)
      await page.getByRole('button', { name: '取消模型请求' }).click()
      await expect(page.getByRole('status').filter({ hasText: '已取消模型请求。' })).toBeVisible()
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await page.waitForTimeout(1400)
      const pending = await page.evaluate(async scope => window.electronAPI!.assets.listAiDrafts({ ...scope }), ids.scope)
      expect(pending).toMatchObject({ page: { total: 0 } })
      await page.getByRole('button', { name: 'AI 整理', exact: true }).click()
      await page.getByLabel('整理模式').selectOption('restructure')
      await page.getByLabel(/同意将原文/).check(); delay = false
      await page.getByRole('button', { name: '生成待采纳草稿' }).click()
      await expect(page.getByLabel('承载方式', { exact: true })).toHaveValue('derived')
      await page.getByLabel('派生名称').fill('AI派生资产')
      await page.getByLabel(/确认采纳此草稿/).check()
      await page.getByRole('button', { name: '采纳草稿' }).click()
      await expect(page.getByLabel('资产详情')).toContainText('AI派生资产')
      await page.getByRole('button', { name: 'AI 整理', exact: true }).click()
      await page.getByLabel(/同意将原文/).check()
      await page.getByRole('button', { name: '生成待采纳草稿' }).click()
      await page.getByRole('button', { name: '丢弃草稿', exact: true }).click()
      await page.getByRole('button', { name: '确认丢弃', exact: true }).click()
      await expect(page.getByText('草稿已丢弃，原文与历史保留。')).toBeVisible()
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.getByRole('button', { name: 'AI 标签建议', exact: true }).click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      await page.screenshot({ path: `../../.git/codex-integration/i5-04-${runtime}-dark-narrow.png` })
    })
  })
}
