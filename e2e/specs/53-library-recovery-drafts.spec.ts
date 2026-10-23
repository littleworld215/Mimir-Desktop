import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { launchApp, mainEntry, type LaunchedApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
import { reopenEvidenceApp } from '../fixtures/libraryEvidence'
import { randomUUID } from 'node:crypto'
import { createEditingRepository } from '../../electron/libraryEditing/repository'
const paper = { arxivId: 'synthetic-recovery', title: '恢复草稿合成文献', authors: [], summary: '离线合成资料', notes: '原始笔记\n\n保留空白', tags: ['old'], projectIds: [], url: 'https://example.org/synthetic', addedAt: '2026-10-23T00:00:00.000Z' }
function start() { return launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => ({ ...seed, spaceData: { ...seed.spaceData, 'library:papers': { [paper.arxivId]: paper } } }) }) }
const rootOf = (ctx: LaunchedApp) => JSON.parse(readFileSync(join(ctx.tempHome.home, '.mimir/store.json'), 'utf8'))['workspaces:list'][0].path as string
const draftPath = (root: string) => join(root, '.mimir/library-editing/drafts.json')
const readDrafts = (root: string) => JSON.parse(readFileSync(draftPath(root), 'utf8'))
const readPaper = (root: string) => JSON.parse(readFileSync(join(root, '.mimir/store.json'), 'utf8'))['library:papers'][paper.arxivId]
async function card(page: Page) { await gotoModule(page, 'library'); const h = page.getByRole('heading', { name: paper.title, exact: true }); await h.click(); return h.locator('xpath=ancestor::div[contains(@class,"group")][1]') }
async function reader(page: Page) { const c = await card(page); await c.getByRole('button', { name: `证据卡：${paper.title}`, exact: true }).click(); const r = page.getByRole('dialog', { name: '文献阅读器', exact: true }); await r.getByRole('tab', { name: '阅读笔记', exact: true }).click(); await r.getByRole('button', { name: '添加', exact: true }).click(); return r }
async function failFormalRenameOnce(ctx: LaunchedApp, root: string) {
  await ctx.app.evaluate((_electron, target) => {
    const fs = process.getBuiltinModule('fs'), original = fs.renameSync; let failed = false
    ;(globalThis as any).__editingFormalFaultObserved = false
    fs.renameSync = ((from: any, to: any) => { if (!failed && String(to) === target) { failed = true; (globalThis as any).__editingFormalFaultObserved = true; throw Error('synthetic formal rename failure') }; return original(from, to) }) as typeof fs.renameSync
    process.getBuiltinModule('module').syncBuiltinESMExports()
  }, join(root, '.mimir/store.json'))
}
/** Only the already verified synthetic child and its exact, captured lock bytes. Never a user instance. */
async function crashOwned(ctx: LaunchedApp, root: string) {
  const cp = ctx.app.process(), pid = await ctx.app.evaluate(() => process.pid)
  const paths = [join(ctx.tempHome.home, '.mimir/registry.writer-lock'), join(root, '.mimir/workspace.writer-lock'), join(root, '.mimir/assets/assets.db.writer-lock')]
  const locks = paths.filter(existsSync).map(path => {
    const rel = relative(realpathSync(ctx.tempHome.root), realpathSync(path))
    expect(rel.startsWith('..')).toBe(false); expect(lstatSync(path).isSymbolicLink()).toBe(false)
    const bytes = readFileSync(path)
    if (bytes.length) expect(JSON.parse(bytes.toString('utf8')).pid).toBe(pid)
    return { path, bytes }
  })
  expect(cp.exitCode).toBeNull(); process.kill(pid, 'SIGKILL')
  await expect.poll(() => cp.exitCode !== null || cp.signalCode !== null).toBe(true)
  expect(() => process.kill(pid, 0)).toThrow()
  const quarantine = join(ctx.tempHome.root, 'owned-crash-lock-evidence'); mkdirSync(quarantine)
  for (const [i, lock] of locks.entries()) {
    expect(readFileSync(lock.path)).toEqual(lock.bytes)
    renameSync(lock.path, join(quarantine, `${i}-${basename(lock.path)}`))
  }
}
async function restartAfterCrash(ctx: LaunchedApp) {
  const app = await electron.launch({ executablePath: process.env.MIMIR_E2E_PACKAGED, args: [...(process.env.MIMIR_E2E_PACKAGED ? [] : [mainEntry]), `--user-data-dir=${ctx.tempHome.userData}`], cwd: ctx.tempHome.root,
    env: { ...process.env, HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' } })
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); await page.waitForFunction(() => !!window.electronAPI?.libraryEditing)
  const actual = await app.evaluate(({ app }) => ({ home: process.getBuiltinModule('os').homedir(), userData: app.getPath('userData') }))
  expect(realpathSync(actual.home)).toBe(realpathSync(ctx.tempHome.home)); expect(realpathSync(actual.userData)).toBe(realpathSync(ctx.tempHome.userData))
  return { app, page }
}
for (const kind of ['notes', 'tags', 'append'] as const) test(`意外终止后显式恢复${kind}，正常离开仍须保存或丢弃`, async ({}, info) => {
  test.setTimeout(180_000)
  const ctx = await start(), root = rootOf(ctx), input = kind === 'notes' ? '' : kind === 'tags' ? '  公平性, , 复现  ' : '\n  追加原输入\n\n保留段落  \n'
  let reopened: { app: ElectronApplication; page: Page } | undefined
  try {
    const editor = kind === 'append' ? await reader(ctx.page) : await card(ctx.page)
    if (kind !== 'append') await editor.getByRole('button', { name: '编辑', exact: true }).nth(kind === 'notes' ? 1 : 0).click()
    const placeholder = kind === 'notes' ? '写下你的阅读笔记...' : kind === 'tags' ? '逗号分隔，如 survey, llm' : '记录阅读心得、关键公式、待办...'
    const began = Date.now(); await editor.getByPlaceholder(placeholder).fill(input)
    await expect(editor.getByText('恢复草稿已暂存（尚未正式保存文献）', { exact: true })).toBeVisible()
    info.annotations.push({ type: 'autosave-observed-ms', description: String(Date.now() - began) })
    expect(readDrafts(root).drafts[0].input).toBe(input); expect(readPaper(root)).toEqual(paper)
    const before = readFileSync(draftPath(root)); await crashOwned(ctx, root); reopened = await restartAfterCrash(ctx)
    expect(readPaper(root)).toEqual(paper); expect(readFileSync(draftPath(root))).toEqual(before)
    const recovered = kind === 'append' ? await reader(reopened.page) : await card(reopened.page)
    if (kind !== 'append') await recovered.getByRole('button', { name: '编辑', exact: true }).nth(kind === 'notes' ? 1 : 0).click()
    await expect(recovered.getByText(/发现已有恢复草稿/)).toBeVisible()
    expect(readFileSync(draftPath(root))).toEqual(before)
    await recovered.getByRole('button', { name: /查看对照/ }).click()
    await expect(recovered.getByLabel('恢复草稿输入')).toHaveText(input)
    await recovered.getByRole('button', { name: '恢复到编辑器', exact: true }).click()
    await expect(recovered.getByPlaceholder(placeholder)).toHaveValue(input)
    await reopened.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 900))
    for (const dark of [false, true]) { await reopened.page.evaluate(v => document.documentElement.classList.toggle('dark', v), dark); await reopened.page.screenshot({ path: info.outputPath(`${kind}-${dark ? 'dark' : 'light'}-800.png`), animations: 'disabled' }) }
    // A real navigation event, then an explicit button on the existing leave guard.
    if (kind === 'append') await recovered.getByTitle('关闭', { exact: true }).click()
    else await reopened.page.getByRole('button', { name: '总览', exact: true }).first().click()
    const guard = reopened.page.getByRole('dialog', { name: '存在未保存的研究资料编辑', exact: true }); await expect(guard).toBeVisible()
    await guard.getByRole('button', { name: '留在这里', exact: true }).click(); await expect(recovered.getByPlaceholder(placeholder)).toHaveValue(input)
    if (kind === 'append') await recovered.getByTitle('关闭', { exact: true }).click(); else await reopened.page.getByRole('button', { name: '总览', exact: true }).first().click()
    await guard.getByRole('button', { name: kind === 'tags' ? '丢弃后离开' : '保存后离开', exact: true }).click()
    await expect.poll(() => readDrafts(root).drafts.length).toBe(0)
    if (kind === 'append') { expect(readPaper(root).notes).toContain(paper.notes); expect(readPaper(root).notes).toContain(input.trim()); expect(readPaper(root).notes.split(input.trim())).toHaveLength(2) }
    else expect(readPaper(root).notes).toBe(kind === 'notes' ? '' : paper.notes)
    expect(readPaper(root).tags).toEqual(paper.tags)
  } finally { await reopened?.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {}); await reopened?.app.close(); await ctx.cleanup() }
})
test('正式rename失败后可继续编辑保存；阅读器失败后可取消，不改变已保存正文', async () => {
  const ctx = await start(), root = rootOf(ctx)
  try {
    const c = await card(ctx.page); await c.getByRole('button', { name: '编辑', exact: true }).last().click()
    const input = c.getByPlaceholder('写下你的阅读笔记...'); await input.fill('首次失败输入'); await failFormalRenameOnce(ctx, root)
    await c.getByRole('button', { name: '保存', exact: true }).click(); await expect(c.getByRole('alert').first()).toBeVisible()
    expect(await ctx.app.evaluate(() => (globalThis as any).__editingFormalFaultObserved)).toBe(true)
    expect(readPaper(root).notes).toBe(paper.notes)
    await input.fill('失败后重新编辑的完整笔记'); await expect(c.getByText('恢复草稿已暂存（尚未正式保存文献）', { exact: true })).toBeVisible()
    await expect.poll(() => readDrafts(root).drafts[0].input).toBe('失败后重新编辑的完整笔记')
    await c.getByRole('button', { name: '保存', exact: true }).click(); await expect(input).toHaveCount(0)
    expect(readPaper(root).notes).toBe('失败后重新编辑的完整笔记')
    await c.getByRole('button', { name: `证据卡：${paper.title}`, exact: true }).click()
    const r = ctx.page.getByRole('dialog', { name: '文献阅读器', exact: true }); await r.getByRole('tab', { name: '阅读笔记', exact: true }).click(); await r.getByRole('button', { name: '添加', exact: true }).click()
    await r.getByPlaceholder('记录阅读心得、关键公式、待办...').fill('失败后明确取消的追加'); await failFormalRenameOnce(ctx, root)
    await r.getByRole('button', { name: '保存', exact: true }).click(); await expect(r.getByRole('alert').first()).toBeVisible()
    expect(await ctx.app.evaluate(() => (globalThis as any).__editingFormalFaultObserved)).toBe(true)
    await r.getByRole('button', { name: '取消', exact: true }).click(); await expect(r.getByPlaceholder('记录阅读心得、关键公式、待办...')).toHaveCount(0)
    expect(readDrafts(root).drafts).toEqual([]); expect(readPaper(root).notes).toBe('失败后重新编辑的完整笔记')
  } finally { await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {}); await ctx.cleanup() }
})
test('列表旧内容与编辑打开时正式文献不同，自动暂存与普通保存均不能覆盖', async () => {
  const ctx = await start(), root = rootOf(ctx)
  try {
    const c = await card(ctx.page)
    await ctx.page.evaluate(id => window.electronAPI!.library.updatePaper({ arxivId: id, notes: '其他入口更新的正式内容' }), paper.arxivId)
    await c.getByRole('button', { name: '编辑', exact: true }).last().click()
    await c.getByPlaceholder('写下你的阅读笔记...').fill('基于旧显示的输入，必须保留')
    await expect(c.getByRole('alert').first()).toContainText('打开编辑器前已更新')
    expect(existsSync(draftPath(root))).toBe(false)
    await c.getByRole('button', { name: '保存', exact: true }).click()
    await c.getByRole('button', { name: '不使用恢复保护保存当前修改', exact: true }).click()
    await expect(c.getByRole('alert').first()).toContainText('正式文献已有更新')
    expect(readPaper(root).notes).toBe('其他入口更新的正式内容')
    await expect(c.getByPlaceholder('写下你的阅读笔记...')).toHaveValue('基于旧显示的输入，必须保留')
  } finally { await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {}); await ctx.cleanup() }
})
test('真实正文保存后清理rename失败，同profile重启只清理残留且不重复追加', async ({}, info) => {
  const ctx = await start(), root = rootOf(ctx); let reopened: Awaited<ReturnType<typeof reopenEvidenceApp>> | undefined
  try {
    const r = await reader(ctx.page), input = '只追加一次\n\n' + '长段落 '.repeat(6000) + '尾部完整'
    await r.getByPlaceholder('记录阅读心得、关键公式、待办...').fill(input)
    await expect(r.getByText('恢复草稿已暂存（尚未正式保存文献）', { exact: true })).toBeVisible()
    await ctx.app.evaluate((_electron, target) => {
      const fs = process.getBuiltinModule('fs'), original = fs.renameSync; let failed = false
      fs.renameSync = ((from: any, to: any) => { if (!failed && String(to) === target && JSON.parse(fs.readFileSync(from, 'utf8')).drafts.length === 0) { failed = true; (globalThis as any).__editingCleanupFaultObserved = true; throw Error('synthetic cleanup rename failure') }; return original(from, to) }) as typeof fs.renameSync
      process.getBuiltinModule('module').syncBuiltinESMExports()
    }, draftPath(root))
    await r.getByRole('button', { name: '保存', exact: true }).click()
    await expect(r.getByText(/文献已保存，恢复草稿清理失败/)).toBeVisible()
    expect(await ctx.app.evaluate(() => (globalThis as any).__editingCleanupFaultObserved)).toBe(true)
    const saved = readPaper(root).notes; expect(saved.split('只追加一次')).toHaveLength(2); expect(saved.endsWith('尾部完整')).toBe(true)
    reopened = await reopenEvidenceApp(ctx); await gotoModule(reopened.page, 'library')
    await reopened.page.getByRole('button', { name: '恢复草稿', exact: true }).click()
    const dialog = reopened.page.getByRole('dialog', { name: '文献恢复草稿', exact: true }); await dialog.getByRole('button', { name: /阅读器追加/ }).click()
    await expect(dialog.getByText('阅读器追加 · 文献已保存，可清理残留草稿', { exact: true })).toBeVisible(); await expect(dialog.getByRole('button', { name: '恢复到编辑器' })).toHaveCount(0)
    expect(await dialog.getByLabel('恢复草稿输入').textContent()).toBe(input)
    await reopened.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 900))
    for (const dark of [false, true]) { await reopened.page.evaluate(v => document.documentElement.classList.toggle('dark', v), dark); await reopened.page.screenshot({ path: info.outputPath(`long-${dark ? 'dark' : 'light'}-800.png`), animations: 'disabled' }) }
    await dialog.getByRole('button', { name: '明确丢弃此草稿', exact: true }).click(); await expect(dialog.getByText('暂无恢复草稿。')).toBeVisible()
    expect(readPaper(root).notes).toBe(saved)
  } finally { await reopened?.app.close(); await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {}); await ctx.cleanup() }
})
test('丢弃等待实际暂存结束，旧会话的迟到请求不能复活文件条目', async () => {
  const ctx = await start(), root = rootOf(ctx)
  try {
    const c = await card(ctx.page); await c.getByRole('button', { name: '编辑', exact: true }).last().click()
    await ctx.app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('libraryEditing:saveDraft')
      ipcMain.removeHandler('libraryEditing:saveDraft')
      ipcMain.handle('libraryEditing:saveDraft', async (...args) => {
        (globalThis as any).__heldEditingWrite = args[1]
        await new Promise<void>(r => { (globalThis as any).__releaseEditingWrite = r })
        return original(...args)
      })
    })
    await c.getByPlaceholder('写下你的阅读笔记...').fill('在途输入')
    await expect.poll(() => ctx.app.evaluate(() => !!(globalThis as any).__releaseEditingWrite)).toBe(true)
    await c.getByRole('button', { name: '取消', exact: true }).click()
    await expect(c.getByPlaceholder('写下你的阅读笔记...')).toHaveValue('在途输入')
    await ctx.app.evaluate(() => (globalThis as any).__releaseEditingWrite())
    await expect(c.getByPlaceholder('写下你的阅读笔记...')).toHaveCount(0)
    expect(readDrafts(root).drafts).toEqual([])
    const late = await ctx.page.evaluate(async () => {
      const list = await window.electronAPI!.libraryEditing.list({}); if (!list.ok) return list
      return list.scope
    })
    const write = await ctx.app.evaluate(() => (globalThis as any).__heldEditingWrite.write)
    // Restore the handler by releasing immediately, retaining its normal production authorization path.
    const resultPromise = ctx.page.evaluate(r => window.electronAPI!.libraryEditing.saveDraft(r), { scope: late as any, write: { ...write, sequence: write.sequence + 1 } })
    await expect.poll(() => ctx.app.evaluate(() => (globalThis as any).__heldEditingWrite.write.sequence)).toBe(write.sequence + 1)
    await ctx.app.evaluate(() => (globalThis as any).__releaseEditingWrite())
    expect(await resultPromise).toMatchObject({ ok: false, code: 'SESSION_CLOSED' }); expect(readDrafts(root).drafts).toEqual([])
  } finally { await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {}); await ctx.cleanup() }
})
test('多条长草稿暂存与主窗口响应记录，不截断且不更新正式文献', async ({}, info) => {
  const text = '长文献草稿\n'.repeat(5000), count = 20
  let root = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => {
    root = seed.workspaces[0].path; mkdirSync(root, { recursive: true })
    const drafts = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), paperId: i ? `synthetic-${i}` : paper.arxivId, kind: 'notes' as const, base: { notes: paper.notes }, input: text + i, revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' }))
    createEditingRepository().commit(root, 0, { schemaVersion: 1, revision: 1, drafts }, () => {})
    return { ...seed, spaceData: { ...seed.spaceData, 'library:papers': Object.fromEntries(drafts.map(d => [d.paperId, { ...paper, arxivId: d.paperId, title: d.paperId === paper.arxivId ? paper.title : d.paperId }])) } }
  } })
  try {
    ctx.page.on('crash', () => console.log('long-draft-renderer-crashed'))
    ctx.page.on('pageerror', e => console.log('long-draft-page-error', e.message.slice(0, 200)))
    const c = await card(ctx.page); await c.getByRole('button', { name: '编辑', exact: true }).last().click(); await c.getByRole('button', { name: /查看对照/ }).click()
    await c.getByRole('button', { name: '恢复到编辑器', exact: true }).click()
    await expect(c.getByPlaceholder('写下你的阅读笔记...')).toHaveValue(text + '0')
    console.log('long-draft-restored', await c.getByPlaceholder('写下你的阅读笔记...').evaluate(el => ({ length: (el as HTMLTextAreaElement).value.length, width: el.clientWidth, height: el.clientHeight, disabled: (el as HTMLTextAreaElement).disabled })))
    const began = Date.now(), input = text + '完整尾部'
    await ctx.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), input)
    await c.getByPlaceholder('写下你的阅读笔记...').click()
    await c.getByPlaceholder('写下你的阅读笔记...').press('Control+A')
    await c.getByPlaceholder('写下你的阅读笔记...').press('Control+V')
    await expect(c.getByText('恢复草稿已暂存（尚未正式保存文献）', { exact: true })).toBeVisible({ timeout: 10_000 })
    const savedMs = Date.now() - began, responseStart = Date.now(); await ctx.page.evaluate(() => window.electronAPI!.getAppVersion()); const responseMs = Date.now() - responseStart
    expect(readDrafts(root).drafts).toHaveLength(count); expect(readDrafts(root).drafts.find((d: any) => d.paperId === paper.arxivId).input).toBe(input); expect(readPaper(root)).toEqual(paper)
    const timing = { count, fileBytes: readFileSync(draftPath(root)).length, savedMs, responseMs }
    console.log('draft-timing', JSON.stringify(timing))
    await info.attach('draft-timing.json', { body: Buffer.from(JSON.stringify(timing)), contentType: 'application/json' })
    await c.getByRole('button', { name: '取消', exact: true }).click(); await expect(c.getByPlaceholder('写下你的阅读笔记...')).toHaveCount(0)
  } finally { await ctx.page.evaluate(() => window.mimirRequestEvidenceLeave?.('discard')).catch(() => {}); await ctx.cleanup() }
})
