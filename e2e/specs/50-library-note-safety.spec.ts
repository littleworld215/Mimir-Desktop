import { test, expect, type ElectronApplication } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

const paper = { arxivId: '2601.10001', title: '合成笔记保护文献', authors: ['Synthetic'], summary: '测试资料', url: 'https://example.org/paper', notes: '[2026-01-01 10:00]\n旧笔记\n\n第二段旧笔记', tags: ['old'], projectIds: [], addedAt: '2026-01-01' }
function start() {
  return launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED,
    transformSeed: seed => ({ ...seed, spaceData: { ...seed.spaceData, 'library:papers': { [paper.arxivId]: paper } } }) })
}
async function failOnce(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const original = handlers.get('libraryEditing:commit')
    if (!original) throw Error('真实更新处理器缺失')
    let first = true
    ipcMain.removeHandler('libraryEditing:commit')
    ipcMain.handle('libraryEditing:commit', (...args) => {
      if (first) { first = false; return { ok: false, message: '合成保存失败' } }
      return original(...args)
    })
  })
}

test('文献卡片：失败保留、成功不丢另一编辑器，保存后离开失败仍保留草稿', async () => {
  const ctx = await start()
  try {
    await gotoModule(ctx.page, 'library')
    const title = ctx.page.getByRole('heading', { name: paper.title })
    await title.click()
    const card = title.locator('xpath=ancestor::div[contains(@class,"group")][1]')
    await card.getByRole('button', { name: '编辑', exact: true }).last().click()
    await card.getByPlaceholder('写下你的阅读笔记...').fill('新笔记完整正文\n\n第二段')
    await failOnce(ctx.app)
    await card.getByRole('button', { name: '保存', exact: true }).click()
    await expect(card.getByRole('alert')).toHaveText('合成保存失败')
    await expect(card.getByPlaceholder('写下你的阅读笔记...')).toHaveValue('新笔记完整正文\n\n第二段')
    expect((await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())).papers).toEqual([paper])
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    await card.getByPlaceholder('逗号分隔，如 survey, llm').fill('draft, 保留')
    await card.getByRole('button', { name: '保存', exact: true }).last().click()
    await expect(card.getByPlaceholder('写下你的阅读笔记...')).toHaveCount(0)
    await expect(card.getByPlaceholder('逗号分隔，如 survey, llm')).toHaveValue('draft, 保留')
    await ctx.page.getByRole('button', { name: '总览', exact: true }).first().click()
    const leave = ctx.page.getByRole('dialog', { name: '存在未保存的研究资料编辑' })
    await expect(leave).toBeVisible()
    await leave.getByRole('button', { name: '留在这里', exact: true }).click()
    await expect(card.getByPlaceholder('逗号分隔，如 survey, llm')).toHaveValue('draft, 保留')
    await failOnce(ctx.app)
    await ctx.page.getByRole('button', { name: '总览', exact: true }).first().click()
    await leave.getByRole('button', { name: '保存后离开', exact: true }).click()
    await expect(card.getByRole('alert')).toHaveText('合成保存失败')
    await expect(card.getByPlaceholder('逗号分隔，如 survey, llm')).toHaveValue('draft, 保留')
    await ctx.page.getByRole('button', { name: '总览', exact: true }).first().click()
    await leave.getByRole('button', { name: '保存后离开', exact: true }).click()
    await expect(ctx.page.locator('.module-title').first()).toContainText('总览')
    const stored = await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())
    expect((stored.papers as Array<{ notes: string; tags: string[] }>)[0]).toMatchObject({ notes: '新笔记完整正文\n\n第二段', tags: ['draft', '保留'] })
  } finally {
    await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {})
    await ctx.cleanup()
  }
})

test('阅读器：保存后打开使用新笔记，失败不假成功，追加保留多段及自由前缀', async ({}, testInfo) => {
  const ctx = await start()
  try {
    await gotoModule(ctx.page, 'library')
    const title = ctx.page.getByRole('heading', { name: paper.title })
    await title.click()
    const card = title.locator('xpath=ancestor::div[contains(@class,"group")][1]')
    await card.getByRole('button', { name: '编辑', exact: true }).last().click()
    const prefix = '保存后打开的自由笔记\n\n保留的第二段'
    await card.getByPlaceholder('写下你的阅读笔记...').fill(prefix)
    await card.getByRole('button', { name: `证据卡：${paper.title}`, exact: true }).click()
    const leave = ctx.page.getByRole('dialog', { name: '存在未保存的研究资料编辑' })
    await leave.getByRole('button', { name: '保存后离开', exact: true }).click()
    const reader = ctx.page.getByRole('dialog', { name: '文献阅读器' })
    await expect(reader).toBeVisible()
    await reader.getByRole('tab', { name: '阅读笔记', exact: true }).click()
    await expect(reader.getByText(prefix, { exact: true })).toBeVisible()
    await reader.getByRole('button', { name: '添加', exact: true }).click()
    const note = '新追加的记录\n\n记录的第二段'
    await reader.getByPlaceholder('记录阅读心得、关键公式、待办...').fill(note)
    await failOnce(ctx.app)
    await reader.getByRole('button', { name: '保存', exact: true }).click()
    await expect(reader.getByRole('alert')).toHaveText('合成保存失败')
    await expect(reader.getByPlaceholder('记录阅读心得、关键公式、待办...')).toHaveValue(note)
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 900))
    await ctx.page.evaluate(() => document.documentElement.classList.remove('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('reader-save-failure-light-800.png'), animations: 'disabled' })
    await ctx.page.evaluate(() => document.documentElement.classList.add('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('reader-save-failure-dark-800.png'), animations: 'disabled' })
    let stored = await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())
    expect((stored.papers as Array<{ notes: string }>)[0]!.notes).toBe(prefix)
    await reader.getByTitle('关闭', { exact: true }).click()
    await leave.getByRole('button', { name: '留在这里', exact: true }).click()
    await expect(reader.getByPlaceholder('记录阅读心得、关键公式、待办...')).toHaveValue(note)
    await reader.getByTitle('关闭', { exact: true }).click()
    await leave.getByRole('button', { name: '保存后离开', exact: true }).click()
    await expect(reader).toHaveCount(0)
    stored = await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())
    const saved = (stored.papers as Array<{ notes: string }>)[0]!.notes
    expect(saved).toContain(prefix)
    expect(saved).toContain(note)
    expect(saved.split('新追加的记录')).toHaveLength(2)
    await expect(card.getByText(prefix, { exact: true })).toBeVisible()
    await expect(card.getByText(note, { exact: true })).toBeVisible()
  } finally {
    await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {})
    await ctx.cleanup()
  }
})
