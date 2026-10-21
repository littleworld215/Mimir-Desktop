import { test, expect, type ElectronApplication } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

/** 只替换一次外部失败响应；之后仍执行实际已注册的业务写入。 */
async function failOnce(app: ElectronApplication, channel: string, message: string) {
  await app.evaluate(({ ipcMain }, args) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const original = handlers.get(args.channel)
    if (!original) throw Error('未找到真实业务处理器')
    let first = true
    ipcMain.removeHandler(args.channel)
    ipcMain.handle(args.channel, (...request) => {
      if (first) { first = false; return { ok: false, message: args.message } }
      return original(...request)
    })
  }, { channel, message })
}

const web = { title: '合成 T2I Fairness', url: 'https://example.org/target', content: '供比较的网页摘要；不代表候选已匹配。', engine: 'synthetic', category: 'science', publishedDate: '' }
const wrong = { id: '2601.00001', title: '合成 Ocean Chemistry', authors: ['Synthetic Author'], summary: '无关首条', published: '2026-01-02', url: 'https://arxiv.org/abs/2601.00001' }
const correct = { ...wrong, id: '2601.00002', title: web.title, summary: '正确候选摘要', url: 'https://arxiv.org/abs/2601.00002' }

test('文献项目：创建及重命名失败保留输入，重试使用真实存储且不产生重复', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    await failOnce(ctx.app, 'library:createProject', '合成创建失败')
    await gotoModule(ctx.page, 'library')
    await ctx.page.getByRole('button', { name: '新建项目', exact: true }).click()
    await ctx.page.getByPlaceholder('项目名称').fill('失败仍保留的课题')
    await ctx.page.getByTitle('创建', { exact: true }).click()
    await expect(ctx.page.getByText('合成创建失败', { exact: true })).toBeVisible()
    await expect(ctx.page.getByPlaceholder('项目名称')).toHaveValue('失败仍保留的课题')
    await ctx.page.getByTitle('创建', { exact: true }).click()
    const chip = ctx.page.getByTitle('失败仍保留的课题', { exact: true })
    await expect(chip).toBeVisible()
    await chip.hover()
    await failOnce(ctx.app, 'library:updateProject', '合成重命名失败')
    await chip.locator('..').getByTitle('重命名', { exact: true }).click()
    await ctx.page.getByLabel('项目新名称').fill('重试后的课题')
    await ctx.page.getByTitle('保存', { exact: true }).click()
    await expect(ctx.page.getByText('合成重命名失败', { exact: true })).toBeVisible()
    await expect(ctx.page.getByLabel('项目新名称')).toHaveValue('重试后的课题')
    await ctx.page.getByTitle('保存', { exact: true }).click()
    await expect(ctx.page.getByTitle('重试后的课题', { exact: true })).toBeVisible()
    const stored = await ctx.page.evaluate(() => window.electronAPI!.library.listProjects())
    expect(stored.projects).toHaveLength(1)
    expect((stored.projects as Array<{ title: string }>)[0]!.title).toBe('重试后的课题')
  } finally { await ctx.cleanup() }
})

test('网页文献：无关首条不写入，取消及失败保留，确认所选候选才写入真实存储', async ({}, testInfo) => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    await ctx.app.evaluate(({ ipcMain }, entries) => {
      ipcMain.removeHandler('library:searchWeb')
      ipcMain.handle('library:searchWeb', () => ({ ok: true, entries: [entries.web] }))
      ipcMain.removeHandler('library:searchArxiv')
      ipcMain.handle('library:searchArxiv', () => ({ ok: true, entries: [entries.wrong, entries.correct] }))
    }, { web, wrong, correct })
    await gotoModule(ctx.page, 'library')
    await ctx.page.getByRole('button', { name: 'Web', exact: true }).click()
    await ctx.page.getByPlaceholder('搜索网页文献...').fill('fairness')
    await ctx.page.getByRole('button', { name: '搜索', exact: true }).click()
    const trigger = ctx.page.getByTitle('按标题查找论文候选并核对', { exact: true })
    await trigger.click()
    const dialog = ctx.page.getByRole('dialog', { name: '核对候选论文' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled()
    expect((await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())).papers).toHaveLength(0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await dialog.getByRole('radio', { name: /合成 T2I Fairness/ }).check()
    await failOnce(ctx.app, 'library:importPaper', '合成导入失败')
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('合成导入失败')
    await expect(dialog.getByRole('radio', { name: /合成 T2I Fairness/ })).toBeChecked()
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 900))
    await ctx.page.evaluate(() => document.documentElement.classList.remove('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('match-light-800.png'), animations: 'disabled' })
    await ctx.page.evaluate(() => document.documentElement.classList.add('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('match-dark-800.png'), animations: 'disabled' })
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const stored = await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())
    expect(stored.papers).toHaveLength(1)
    expect((stored.papers as Array<{ arxivId: string }>)[0]!.arxivId).toBe(correct.id)
    await expect(trigger).toBeFocused()
  } finally { await ctx.cleanup() }
})
