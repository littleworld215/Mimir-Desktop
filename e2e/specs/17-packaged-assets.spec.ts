import { test, expect, _electron as electron } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('packaged SQLite, second-instance exclusion and clean persisted reopen', async () => {
  const executablePath = resolve(process.env.MIMIR_E2E_PACKAGED!)
  const launched = await launchApp({ executablePath })
  const { page, app, tempHome } = launched
  try {
    await gotoModule(page, 'assets')
    await expect(page.getByRole('button', { name: '新建资产', exact: true }).first()).toBeEnabled()
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const created = await page.evaluate(async () => {
      const api = window.electronAPI!.assets
      const result = await api.context()
      if (!result.ok) throw new Error(result.message)
      return api.create({ ...result.context, input: { name: '打包原文', category: 'inbox', storageType: 'inline_text', content: '  packaged\n\n' } })
    })
    expect(created.ok).toBe(true)
    const changedCategory = await page.evaluate(async () => {
      const api = window.electronAPI!.assets
      const scope = await api.context()
      if (!scope.ok) throw new Error(scope.message)
      const categories = await api.listCategories(scope.context)
      if (!categories.ok) throw new Error(categories.message)
      const inbox = categories.categories.find(category => category.code === 'inbox')!
      return api.updateCategory({ ...scope.context, code: inbox.code, expectedRevision: inbox.revision, patch: { name: '保留的分类名称' } })
    })
    expect(changedCategory.ok).toBe(true)
    const dbPath = join(tempHome.home, 'Mimir', '科研空间', '.mimir', 'assets', 'assets.db')
    expect(existsSync(dbPath)).toBe(true)
    // Start an actual second OS process sharing both HOME and Chromium userData.
    // No bypass flag, test service, development entry or alternate lock namespace.
    const second = spawn(executablePath, [`--user-data-dir=${tempHome.userData}`], {
      env: { ...process.env, HOME: tempHome.home, USERPROFILE: tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' },
      windowsHide: true, stdio: 'ignore'
    })
    try {
      const exited = await Promise.race([
        once(second, 'exit'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Second instance did not exit')), 15_000).unref())
      ])
      expect(exited[0]).toBe(0)
      expect(app.process().exitCode).toBeNull()
      const listed = await page.evaluate(async () => {
        const api = window.electronAPI!.assets
        const result = await api.context()
        if (!result.ok) throw new Error(result.message)
        return api.list(result.context)
      })
      expect(listed.ok).toBe(true)
      await page.getByRole('button', { name: '新建资产', exact: true }).first().click()
      await page.getByLabel('名称', { exact: true }).fill('第二实例退出后仍可写')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(page.getByRole('article', { name: '资产详情' })).toContainText('第二实例退出后仍可写')
    } finally {
      if (second.exitCode === null) { second.kill(); await once(second, 'exit') }
    }
    const processHandle = app.process()
    await app.close()
    expect(processHandle.exitCode).toBe(0)
    // Node can reopen only after the packaged Electron process released its DB.
    const db = new Database(dbPath, { readonly: true })
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(db.prepare('SELECT count(*) AS n FROM asset').get()).toEqual({ n: 2 })
      expect(db.prepare('SELECT content FROM asset_version ORDER BY id LIMIT 1').get()).toEqual({ content: '  packaged\n\n' })
    } finally { db.close() }
    // Restart the same packaged application against the same isolated space.
    // Do not rewrite seed/store files: startup must preserve both data and edits.
    const restarted = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${tempHome.userData}`],
      env: { ...process.env, HOME: tempHome.home, USERPROFILE: tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' }
    })
    try {
      const actualHome = await restarted.evaluate(() => process.getBuiltinModule('os').homedir())
      expect(realpathSync(actualHome)).toBe(realpathSync(tempHome.home))
      const restartedPage = await restarted.firstWindow()
      await gotoModule(restartedPage, 'assets')
      await expect(restartedPage.getByRole('button', { name: '新建资产', exact: true }).first()).toBeEnabled()
      const result = await restartedPage.evaluate(async () => {
        const api = window.electronAPI!.assets
        const scope = await api.context()
        if (!scope.ok) throw new Error(scope.message)
        return { list: await api.list(scope.context), categories: await api.listCategories(scope.context) }
      })
      expect(result.list.ok && result.list.page.items.length).toBe(2)
      expect(result.categories.ok && result.categories.categories.find(category => category.code === 'inbox')!.name).toBe('保留的分类名称')
      await restartedPage.getByRole('button', { name: '新建资产', exact: true }).first().click()
      await restartedPage.getByLabel('名称', { exact: true }).fill('重启后可写')
      await restartedPage.getByRole('button', { name: '保存', exact: true }).click()
      await expect(restartedPage.getByRole('article', { name: '资产详情' })).toContainText('重启后可写')
    } finally { await restarted.close() }
  } finally { await launched.cleanup() }
})
