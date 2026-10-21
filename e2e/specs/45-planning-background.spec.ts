import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
import { emptyPlanningInput } from '../../shared/researchPlanningDefaults'
import { localPlanningDate } from '../../shared/researchPlanningDates'

test('科研计划后台：默认关闭、实际托盘隐藏/重显，显式退出仍保护未保存输入', async () => {
  test.setTimeout(180_000)
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED })
  try {
    await gotoModule(ctx.page, 'settings')
    await ctx.page.getByRole('main').getByRole('button', { name: '科研计划', exact: true }).click()
    const tray = ctx.page.getByLabel('关闭窗口后驻留托盘')
    await expect(tray).not.toBeChecked(); await expect(ctx.page.getByLabel('运行期间提醒')).not.toBeChecked(); await expect(ctx.page.getByLabel('开机启动')).not.toBeChecked()
    await tray.check(); await ctx.page.getByRole('button', { name: '保存科研计划后台偏好' }).click()
    await expect(ctx.page.getByText('后台偏好已保存', { exact: true })).toBeVisible()
    await expect(ctx.page.getByText(/托盘：运行中/)).toBeVisible()
    await gotoModule(ctx.page, 'planning'); await ctx.page.getByRole('button', { name: '新建科研项目', exact: true }).click()
    await ctx.page.getByLabel('标题', { exact: true }).fill('托盘保留输入')
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false)
    await ctx.app.evaluate(({ app }) => { app.emit('second-instance', {}, [], '') })
    await expect.poll(() => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true)
    await expect(ctx.page.getByLabel('标题', { exact: true })).toHaveValue('托盘保留输入')
    await ctx.app.evaluate(({ app, dialog }) => { dialog.showMessageBoxSync = () => 0; app.quit() })
    await expect(ctx.page.getByLabel('标题', { exact: true })).toHaveValue('托盘保留输入')
    await expect.poll(() => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    // Restore the fixture's explicit discard choice for this temporary app's normal cleanup.
    await ctx.app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 2 })
    await ctx.page.getByRole('button', { name: '取消编辑', exact: true }).click()
    await ctx.page.getByRole('button', { name: '丢弃后离开', exact: true }).click()
    await gotoModule(ctx.page, 'settings'); await ctx.page.getByRole('main').getByRole('button', { name: '科研计划', exact: true }).click()
    await ctx.page.getByLabel('关闭窗口后驻留托盘').uncheck(); await ctx.page.getByRole('button', { name: '保存科研计划后台偏好' }).click()
    await expect(ctx.page.getByText(/托盘：未运行/)).toBeVisible()
    const directory = join(process.cwd(), '../../.local/i10-execution/visual'); mkdirSync(directory, { recursive: true })
    await ctx.page.setViewportSize({ width: 800, height: 1000 })
    await ctx.page.screenshot({ animations: 'disabled', path: join(directory, 'batch5-background-light-800.png') })
    await ctx.page.evaluate(() => document.documentElement.classList.add('dark'))
    await expect.poll(() => ctx.page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
    await ctx.page.screenshot({ animations: 'disabled', path: join(directory, 'batch5-background-dark-800.png') })
    expect(await ctx.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await ctx.cleanup() }
})

test('科研计划后台：原生通知适配假呈现、成功去重及真实页面点击/取消保护', async () => {
  test.setTimeout(180_000)
  let root = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { root = seed.workspaces[0]!.path; return seed } })
  try {
    await ctx.app.evaluate(({ Notification, app }) => {
      ;(globalThis as any).__i10Notices = []
      ;(globalThis as any).__i10StartupWrites = 0
      app.setLoginItemSettings = () => { (globalThis as any).__i10StartupWrites++; throw Error('OS_STARTUP_WRITE_FORBIDDEN_IN_TEST') }
      Notification.isSupported = () => true
      Notification.prototype.show = function () { (globalThis as any).__i10Notices.push(this); this.emit('show') }
      Notification.prototype.close = function () { this.emit('close') }
    })
    const items = await ctx.page.evaluate(async input => {
      const api = window.electronAPI!.researchPlanning, b = await api.bootstrap({}); if (!b.ok) throw Error('bootstrap')
      const one = await api.save({ scope: b.scope, expectedRevision: b.revision, input: { ...input, title: '通知待办甲' } }); if (!one.ok) throw Error('save')
      const two = await api.save({ scope: b.scope, expectedRevision: one.revision, input: { ...input, title: '通知待办乙' } }); if (!two.ok) throw Error('save')
      return [one.item.id, two.item.id]
    }, { ...emptyPlanningInput('todo'), dueDate: localPlanningDate() })
    await gotoModule(ctx.page, 'settings'); await ctx.page.getByRole('main').getByRole('button', { name: '科研计划', exact: true }).click()
    await ctx.page.getByLabel('运行期间提醒').check(); await ctx.page.getByRole('button', { name: '保存科研计划后台偏好' }).click()
    const file = join(root, '.mimir/planning/deliveries.json')
    await expect.poll(() => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).deliveries.length : 0).toBe(2)
    const title = await ctx.app.evaluate(() => { const notice = (globalThis as any).__i10Notices[0]; notice.emit('click'); return notice.body.split('\n')[0] as string })
    await expect(ctx.page.getByLabel('标题', { exact: true })).toHaveValue(title)
    await ctx.page.getByLabel('正文', { exact: true }).fill('通知切换不能丢失此输入')
    await ctx.app.evaluate(() => { (globalThis as any).__i10Notices[1].emit('click') })
    await expect(ctx.page.getByRole('dialog', { name: '存在未保存的研究资料编辑' })).toBeVisible()
    await ctx.page.getByRole('button', { name: '留在这里', exact: true }).click()
    await expect(ctx.page.getByLabel('正文', { exact: true })).toHaveValue('通知切换不能丢失此输入')
    expect(JSON.parse(readFileSync(file, 'utf8')).deliveries.map((d: { itemId: string }) => d.itemId).sort()).toEqual(items.sort())
    expect(await ctx.app.evaluate(() => (globalThis as any).__i10StartupWrites)).toBe(0)
  } finally { await ctx.cleanup() }
})

test('科研计划后台：空间切换后旧通知无效，新空间不继承旧空间去重状态', async () => {
  test.setTimeout(180_000)
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => ({ ...seed, workspaces: [...seed.workspaces, { ...seed.workspaces[0]!, id: 'second-space', name: '第二合成空间', path: join(seed.workspaces[0]!.path, '../第二合成空间') }] }) })
  try {
    await ctx.app.evaluate(({ Notification }) => {
      ;(globalThis as any).__i10Notices = []
      Notification.isSupported = () => true
      Notification.prototype.show = function () { (globalThis as any).__i10Notices.push(this); this.emit('show') }
      Notification.prototype.close = function () { this.emit('close') }
    })
    await ctx.page.evaluate(async input => { const api = window.electronAPI!.researchPlanning, b = await api.bootstrap({}); if (!b.ok) throw Error('bootstrap'); const saved = await api.save({ scope: b.scope, expectedRevision: b.revision, input }); if (!saved.ok) throw Error('save'); const preferences = await api.background({ scope: b.scope }); if (!preferences.ok) throw Error('preferences'); const result = await api.saveBackground({ scope: b.scope, expectedRevision: preferences.state.preferences.revision, input: { tray: false, startup: false, reminders: true } }); if (!result.ok) throw Error('background') }, { ...emptyPlanningInput('todo'), title: '旧空间通知', dueDate: localPlanningDate() })
    await expect.poll(() => ctx.app.evaluate(() => (globalThis as any).__i10Notices.length)).toBe(1)
    await ctx.page.getByTitle('切换科研空间', { exact: true }).click(); await ctx.page.getByRole('button', { name: '第二合成空间', exact: true }).click()
    await expect.poll(() => ctx.page.evaluate(async () => { const b = await window.electronAPI!.researchPlanning.bootstrap({}); return b.ok ? b.scope.workspaceId : null })).toBe('second-space')
    await ctx.app.evaluate(() => { (globalThis as any).__i10Notices[0].emit('click') })
    await expect(ctx.page.getByPlaceholder('今天帮你做些什么？输入 / 可调用技能与指令')).toBeVisible()
    await gotoModule(ctx.page, 'planning')
    const state = await ctx.page.evaluate(async () => { const api = window.electronAPI!.researchPlanning, b = await api.bootstrap({}); if (!b.ok) throw Error('bootstrap'); const list = await api.list({ scope: b.scope, filter: {}, page: 1 }); return list })
    expect(state).toMatchObject({ ok: true, total: 0 })
  } finally { await ctx.cleanup() }
})
