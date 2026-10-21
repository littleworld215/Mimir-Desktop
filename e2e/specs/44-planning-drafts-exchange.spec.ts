import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, mainEntry, repoRoot, type LaunchedApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

/** 仅重新启动本用例已通过隔离校验的同一HOME/profile，不接受任意用户路径。 */
async function restartIsolated(ctx: LaunchedApp) {
  const root = realpathSync(ctx.tempHome.root)
  if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('mimir-e2e-') || realpathSync(ctx.paths.userData) !== realpathSync(ctx.tempHome.userData) || realpathSync(ctx.paths.home) !== realpathSync(ctx.tempHome.home)) throw Error('拒绝重启未经核定的profile')
  await ctx.app.close()
  const app = await electron.launch({ executablePath: process.env.MIMIR_E2E_PACKAGED, args: [...(process.env.MIMIR_E2E_PACKAGED ? [] : [mainEntry]), `--user-data-dir=${ctx.tempHome.userData}`], cwd: repoRoot, env: { ...(process.env as Record<string, string>), HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' }, timeout: 60_000 })
  try {
    const page = await app.firstWindow()
    const paths = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), home: process.getBuiltinModule('os').homedir() }))
    if (realpathSync(paths.userData) !== realpathSync(ctx.tempHome.userData) || realpathSync(paths.home) !== realpathSync(ctx.tempHome.home)) throw Error('重启后的隔离路径不匹配')
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 2; dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }) })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}

test('科研计划：正常退出后同profile新进程恢复草稿，正式保存才清理草稿', async () => {
  test.setTimeout(180_000)
  let root = '', restarted: ElectronApplication | undefined
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { root = seed.workspaces[0]!.path; return seed } })
  try {
    await gotoModule(ctx.page, 'planning')
    await ctx.page.getByRole('navigation', { name: '计划内容' }).getByRole('button', { name: '记录', exact: true }).click()
    await ctx.page.getByRole('button', { name: '新建记录', exact: true }).click()
    const content = '\n  合成未命名草稿\n\n'
    await ctx.page.getByLabel('正文', { exact: true }).fill(content)
    const file = join(root, '.mimir/planning/drafts.json')
    await expect.poll(() => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).drafts[0]?.input.content : null).toBe(content)
    await ctx.page.getByRole('button', { name: '保留草稿并返回', exact: true }).click()
    await expect(ctx.page.getByText('恢复草稿（1）· 尚未正式保存', { exact: true })).toBeVisible()
    expect(existsSync(join(root, '.mimir/planning/planning.json'))).toBe(false)
    const before = readFileSync(file)
    const next = await restartIsolated(ctx); restarted = next.app
    expect(readFileSync(file)).toEqual(before)
    await gotoModule(next.page, 'planning')
    await next.page.getByText('恢复草稿（1）· 尚未正式保存', { exact: true }).click()
    await next.page.getByRole('button', { name: '恢复编辑未命名草稿', exact: true }).click()
    await expect(next.page.getByRole('dialog', { name: '核对恢复草稿' })).toBeVisible()
    const directory = join(process.cwd(), '../../.local/i10-execution/visual'); mkdirSync(directory, { recursive: true })
    await next.page.setViewportSize({ width: 800, height: 1000 })
    for (const dark of [false, true]) {
      await next.page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await expect.poll(() => next.page.getByRole('dialog', { name: '核对恢复草稿' }).evaluate(element => {
        const style = getComputedStyle(element)
        const luminance = (rgb: string) => { const values = rgb.match(/[\d.]+/g)!.slice(0, 3).map(value => { const channel = Number(value) / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4 }); return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722 }
        const a = luminance(style.color), b = luminance(style.backgroundColor)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })).toBeGreaterThanOrEqual(4.5)
      await next.page.screenshot({ animations: 'disabled', path: join(directory, `batch4-recovery-${dark ? 'dark' : 'light'}-800.png`) })
    }
    await next.page.getByRole('button', { name: '已核对，采用当前修订继续编辑', exact: true }).click()
    await expect(next.page.getByLabel('正文', { exact: true })).toHaveValue(content)
    await next.page.getByLabel('标题', { exact: true }).fill('恢复后正式保存')
    await next.page.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(root, '.mimir/planning/planning.json'), 'utf8')).items[0]?.content).toBe(content)
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).drafts.length).toBe(0)
  } finally { if (restarted) await restarted.close(); await ctx.cleanup() }
})

test('科研计划：文献项目、实验与文献标识关联及原生模块跳转', async () => {
  test.setTimeout(180_000)
  const stamp = '2026-10-21T00:00:00.000Z'
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => ({ ...seed, spaceData: { 'library:projects': [{ id: 'library-project', title: '文献课题', createdAt: stamp, updatedAt: stamp }], 'experiments:list': [{ id: 'exp', name: '合成实验', status: 'success', metrics: { accuracy: 0.9 }, updatedAt: stamp }], 'library:papers': { 'doi:10.1000/synthetic': { arxivId: 'doi:10.1000/synthetic', title: '合成文献', authors: ['合成作者'], summary: '合成摘要', url: '', notes: '[2026-10-21 09:00]\n字典中的原始阅读笔记', tags: [], projectIds: [], addedAt: stamp } } } }) })
  try {
    const { page } = ctx
    await gotoModule(page, 'planning')
    await page.getByRole('button', { name: '新建科研项目', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('规划课题')
    await page.getByRole('button', { name: '选择文献项目', exact: true }).click()
    await page.getByRole('button', { name: '文献课题', exact: true }).click()
    await page.getByRole('button', { name: '选择实验', exact: true }).click()
    await page.getByRole('button', { name: '合成实验', exact: true }).click()
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await page.getByRole('button', { name: '打开关联文献项目', exact: true }).click()
    await expect(page.locator('.module-title').first()).toHaveText('文献库')
    await expect(page.getByText('该项目暂无论文', { exact: true })).toBeVisible()
    await gotoModule(page, 'planning')
    await page.getByRole('button', { name: '打开关联实验', exact: true }).click()
    await expect(page.locator('.module-title').first()).toHaveText('实验管理')
    await expect(page.getByText('合成实验', { exact: true }).first()).toBeVisible()
    await gotoModule(page, 'planning')
    await page.getByRole('button', { name: '文献计划', exact: true }).click()
    await page.getByRole('button', { name: '新建文献计划', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('书目计划')
    await page.getByLabel('作者（每行一位）', { exact: true }).fill('作者甲\n作者乙')
    await page.getByRole('button', { name: '选择文献', exact: true }).click()
    await page.getByRole('button', { name: '合成文献', exact: true }).click()
    await page.getByRole('button', { name: '保存记录', exact: true }).click()
    await page.getByRole('button', { name: '打开关联文献', exact: true }).click()
    await expect(page.getByRole('dialog').getByText('合成文献', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('dialog').getByText('字典中的原始阅读笔记', { exact: true })).toBeVisible()
  } finally { await ctx.cleanup() }
})

function foreign(version: 1 | 2) {
  const stamp = Date.parse('2026-10-21T00:00:00.000Z')
  return { app: 'research-workbench', version, exportedAt: new Date(stamp).toISOString(), types: [{ id: 'generic', name: '导入记录', kind: 'generic', icon: 'note', note: '♪', builtin: true }], workspaces: [{ id: 'foreign', name: '外部分组', builtin: true }], records: [{ id: `record-${version}`, typeId: 'generic', workspaceId: 'foreign', title: `外部记录v${version}`, content: '\n  外部原文\n\n<img src="https://example.test/a"><script>alert(1)</script>', status: 'active', starred: false, archived: false, fields: [], priority: 'none', dueDate: null, done: false, planDate: null, planStart: null, planEnd: null, createdAt: stamp, updatedAt: stamp, ...(version === 2 ? { projectId: null, recurrence: null, literature: { authors: '作者甲\n作者乙', year: 2026, doi: '10.1000/synthetic', url: 'https://example.test/paper', readingStatus: 'reading' } } : {}) }], ...(version === 2 ? { settings: { autoLaunch: true, notificationsEnabled: true } } : {}) }
}
test('科研计划：两版JSON预览合并、重复策略、四格式原生新文件保存', async () => {
  test.setTimeout(240_000)
  let root = '', source1 = '', source2 = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => {
    root = seed.workspaces[0]!.path
    const input = join(root, '合成导入'); mkdirSync(input, { recursive: true })
    source1 = join(input, 'v1.json'); source2 = join(input, 'v2.json')
    writeFileSync(source1, JSON.stringify(foreign(1))); writeFileSync(source2, JSON.stringify(foreign(2)))
    return seed
  } })
  try {
    const { page } = ctx, globalFile = join(ctx.tempHome.home, '.mimir/store.json'), settings = JSON.parse(readFileSync(globalFile, 'utf8')).settings
    await gotoModule(page, 'planning')
    async function importFile(path: string, strategy: 'skip' | 'copy' = 'skip') {
      await ctx.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
      await page.getByRole('button', { name: '导入与导出', exact: true }).click()
      await page.getByRole('button', { name: '选择JSON并读取预览信息', exact: true }).click()
      await expect(page.getByText(basename(path), { exact: true })).toBeVisible()
      await page.getByLabel('重复项策略', { exact: true }).selectOption(strategy)
      await page.getByRole('button', { name: '预览导入差异', exact: true }).click()
      await expect(page.getByRole('button', { name: '确认按预览导入', exact: true })).toBeVisible()
      const difference = page.getByRole('button', { name: '查看完整差异外部记录v1', exact: true })
      if (await difference.count()) { await difference.click(); await expect(page.getByLabel('导入记录完整字段', { exact: true })).toHaveValue(/外部原文/) }
      await page.getByRole('button', { name: '确认按预览导入', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '科研计划导入与导出' })).toBeHidden()
    }
    const read = () => JSON.parse(readFileSync(join(root, '.mimir/planning/planning.json'), 'utf8'))
    await importFile(source1); expect(read().items).toHaveLength(1)
    await importFile(source1); expect(read().items).toHaveLength(1)
    await importFile(source1, 'copy'); expect(read().items).toHaveLength(2)
    await importFile(source2); expect(read().items).toHaveLength(3)
    expect(read().items.find((item: { kind: string }) => item.kind === 'literature').literature.authors).toEqual(['作者甲', '作者乙'])
    expect(JSON.parse(readFileSync(globalFile, 'utf8')).settings).toEqual(settings)
    const directory = join(ctx.tempHome.root, 'exports'); mkdirSync(directory)
    for (const format of ['json', 'markdown', 'csv', 'html']) {
      const output = join(directory, `科研计划.${format === 'markdown' ? 'md' : format}`)
      await ctx.app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, output)
      await page.getByRole('button', { name: '导入与导出', exact: true }).click()
      await page.getByLabel('导出格式', { exact: true }).selectOption(format)
      await page.getByRole('button', { name: '生成导出预览', exact: true }).click()
      await expect(page.getByLabel('导出文件完整文本（只读）', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '选择位置并保存新文件', exact: true }).click()
      await expect(page.getByText(`已保存新文件：${basename(output)}`, { exact: true })).toBeVisible()
      const text = readFileSync(output, 'utf8')
      if (format === 'json') expect(JSON.parse(text).document.items).toHaveLength(3)
      if (format === 'html') { expect(text).not.toContain('<img '); expect(text).not.toContain('<script>') }
      await page.getByRole('button', { name: '关闭交换窗口', exact: true }).click()
    }
  } finally { await ctx.cleanup() }
})
