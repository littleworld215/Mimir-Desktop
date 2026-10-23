import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { seedResearch } from '../fixtures/libraryResearch'
import { reopenEvidenceApp } from '../fixtures/libraryEvidence'
import { gotoModule } from '../helpers/nav'
import { randomUUID } from 'node:crypto'
import { createEditingRepository } from '../../electron/libraryEditing/repository'

test('回收与恢复：真实关联预览、历史与PDF保全、重导入拒绝、同profile重启', async ({}, testInfo) => {
  test.setTimeout(180_000)
  let fixture!: ReturnType<typeof seedResearch>
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => {
    fixture = seedResearch(seed)
    fixture.papers[0]!.dates = { sourcePublished: { value: '2024', precision: 'year', source: 'openalex' } }
    createEditingRepository().commit(fixture.root, 0, { schemaVersion: 1, revision: 1, drafts: [{ id: randomUUID(), paperId: fixture.papers[0].arxivId, kind: 'notes', base: { notes: fixture.papers[0].notes }, input: '\n 回收后仍可复制 \n', revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' }] }, () => {})
    return fixture.seed
  } })
  let restarted: Awaited<ReturnType<typeof reopenEvidenceApp>> | undefined
  try {
    const original = fixture.papers[0]!, storePath = join(fixture.root, '.mimir/store.json')
    const historyPaths = ['evidence.json', 'research.json'].map(name => join(fixture.root, '.mimir/library', name))
    const history = historyPaths.map(path => readFileSync(path)), pdf = readFileSync(original.pdfPath!)
    const draftPath = join(fixture.root, '.mimir/library-editing/drafts.json'), draftBytes = readFileSync(draftPath)
    await gotoModule(ctx.page, 'library')
    const heading = ctx.page.getByRole('heading', { name: original.title, exact: true })
    const card = heading.locator('xpath=ancestor::div[contains(@class,"group")][1]')
    await card.getByTitle('从文献库移除', { exact: true }).click()
    const preview = ctx.page.getByRole('dialog', { name: '移入文献回收站', exact: true })
    await expect(preview.getByText(/证据卡 2 张/)).toBeVisible()
    await expect(preview.getByText(/文献编辑恢复草稿 1 条/)).toBeVisible()
    await preview.getByRole('button', { name: '取消', exact: true }).click()
    expect(JSON.parse(readFileSync(storePath, 'utf8'))['library:papers'][original.arxivId]).toEqual(original)
    await card.getByTitle('从文献库移除', { exact: true }).click()
    await expect(preview.getByText(/证据卡 2 张/)).toBeVisible()
    await preview.getByRole('button', { name: '确认移入回收站', exact: true }).click()
    await expect(preview).toBeHidden()
    await expect(heading).toHaveCount(0)
    const stored = JSON.parse(readFileSync(storePath, 'utf8'))['library:papers'][original.arxivId]
    expect(stored).toMatchObject({ ...original, removedAt: expect.any(String) })
    const reimport = await ctx.page.evaluate(p => window.electronAPI!.library.importPaper({
      id: p.arxivId, title: '不应覆盖', authors: [], summary: '', published: '', url: ''
    }), original)
    expect(reimport).toMatchObject({ ok: false })
    expect(reimport.message).toContain('回收站')
    await ctx.page.getByRole('button', { name: '恢复草稿', exact: true }).click()
    const recovery = ctx.page.getByRole('dialog', { name: '文献恢复草稿', exact: true })
    await recovery.getByRole('button', { name: /自由笔记/ }).click()
    await expect(recovery.getByText('自由笔记 · 文献在回收站，仅查看复制')).toBeVisible()
    expect(await recovery.getByLabel('恢复草稿输入').textContent()).toBe('\n 回收后仍可复制 \n')
    await recovery.getByRole('button', { name: '复制草稿输入', exact: true }).click()
    // Windows clipboard represents text lines as CRLF; draft-file bytes above/below stay exact.
    expect((await ctx.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')).toBe('\n 回收后仍可复制 \n')
    await recovery.getByRole('button', { name: '关闭', exact: true }).click()
    expect(readFileSync(draftPath)).toEqual(draftBytes)
    await ctx.page.getByRole('button', { name: '证据比较矩阵', exact: true }).click()
    await expect(ctx.page.getByText('来源文献已移除，快照保留', { exact: true })).toBeVisible()
    await ctx.page.getByRole('button', { name: '返回文献列表', exact: true }).click()
    await ctx.page.getByRole('button', { name: '文献回收站', exact: true }).click()
    const trash = ctx.page.getByRole('dialog', { name: '文献回收站', exact: true })
    await trash.getByRole('button', { name: '恢复：' + original.title, exact: true }).click()
    const restore = ctx.page.getByRole('dialog', { name: '恢复文献', exact: true })
    await expect(restore.getByText(/证据卡 2 张/)).toBeVisible()
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 900))
    await ctx.page.screenshot({ path: testInfo.outputPath('restore-light-800.png'), animations: 'disabled' })
    await ctx.page.evaluate(() => document.documentElement.classList.add('dark'))
    await ctx.page.screenshot({ path: testInfo.outputPath('restore-dark-800.png'), animations: 'disabled' })
    await restore.getByRole('button', { name: '确认恢复', exact: true }).click()
    await expect(restore).toBeHidden()
    await expect(heading).toBeVisible()
    expect(JSON.parse(readFileSync(storePath, 'utf8'))['library:papers'][original.arxivId]).toEqual(original)
    expect(historyPaths.map(path => readFileSync(path))).toEqual(history)
    expect(readFileSync(original.pdfPath!)).toEqual(pdf)
    expect(readFileSync(draftPath)).toEqual(draftBytes)
    restarted = await reopenEvidenceApp(ctx)
    await gotoModule(restarted.page, 'library')
    await expect(restarted.page.getByRole('heading', { name: original.title, exact: true })).toBeVisible()
    const result = await restarted.page.evaluate(() => window.electronAPI!.library.listPapers())
    expect(result.papers).toContainEqual(original)
  } finally {
    await restarted?.app.close()
    await ctx.cleanup()
  }
})

test('真实失败保留确认与草稿，旧预览及旧移除接口不能写入', async () => {
  const paper = { arxivId: 'synthetic', title: '回收失败保护', authors: [], summary: '', url: '', notes: '旧笔记', tags: [], projectIds: [], addedAt: '2024-01-01' }
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED,
    transformSeed: seed => ({ ...seed, spaceData: { ...seed.spaceData, 'library:papers': { synthetic: paper } } }) })
  try {
    await gotoModule(ctx.page, 'library')
    await ctx.page.getByRole('heading', { name: paper.title }).click()
    await ctx.page.getByRole('button', { name: '编辑', exact: true }).last().click()
    await ctx.page.getByPlaceholder('写下你的阅读笔记...').fill('未保存草稿')
    await ctx.page.getByTitle('从文献库移除').click()
    const leave = ctx.page.getByRole('dialog', { name: '存在未保存的研究资料编辑' })
    await leave.getByRole('button', { name: '留在这里', exact: true }).click()
    await expect(ctx.page.getByPlaceholder('写下你的阅读笔记...')).toHaveValue('未保存草稿')
    await ctx.page.getByTitle('从文献库移除').click()
    await leave.getByRole('button', { name: '保存后离开', exact: true }).click()
    const preview = ctx.page.getByRole('dialog', { name: '移入文献回收站', exact: true })
    await expect(preview.getByRole('button', { name: '确认移入回收站' })).toBeEnabled()
    await ctx.app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => unknown>
      const original = handlers.get('library:applyPaperLifecycle')!
      let first = true
      ipcMain.removeHandler('library:applyPaperLifecycle')
      ipcMain.handle('library:applyPaperLifecycle', (...args) => { if (first) { first = false; return { ok: false, message: '合成写入失败' } }; return original(...args) })
    })
    await preview.getByRole('button', { name: '确认移入回收站' }).click()
    await expect(preview.getByRole('alert')).toHaveText('合成写入失败')
    expect((await ctx.page.evaluate(() => window.electronAPI!.library.listPapers())).papers).toContainEqual({ ...paper, notes: '未保存草稿' })
    await preview.getByRole('button', { name: '取消' }).click()
    const stale = await ctx.page.evaluate(async () => {
      const api = window.electronAPI!.library
      const scope = (await api.listPapers()).scope!
      const preview = await api.previewPaperLifecycle({ scope, arxivId: 'synthetic', action: 'trash' })
      if (!preview.ok) throw Error(preview.message)
      await api.updatePaper({ arxivId: 'synthetic', notes: '晚到编辑' })
      return { apply: await api.applyPaperLifecycle({ scope, token: preview.preview.token }), legacy: await api.removePaper('synthetic'), papers: (await api.listPapers()).papers }
    })
    expect(stale.apply.ok).toBe(false); expect(stale.legacy.ok).toBe(false)
    expect(stale.papers).toContainEqual({ ...paper, notes: '晚到编辑' })
  } finally {
    await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {})
    await ctx.cleanup()
  }
})
