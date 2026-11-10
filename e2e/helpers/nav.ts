/**
 * 导航与模块断言 helper。
 *
 * 定位策略（实测得出）：
 * - 侧栏项：原生 `<button>` + 可见中文文本，无 testid → 用 `getByRole('button', { name, exact: true })`。
 *   `exact: true` 必要，否则「会议」会同时命中「组会」相关文案。
 * - 模块标题：所有模块统一用 `.module-title` 类（见各模块 header），是最稳的锚点，
 *   不依赖具体文案改动 → 用 `page.locator('.module-title')` 拿当前模块标题文本。
 */
import { errors, expect, type Page } from '@playwright/test'

/** ModuleId → 侧栏可见文案（对照 src/components/layout/Sidebar.tsx navGroups）。 */
export const MODULE_LABELS = {
  chat: '对话',
  overview: '总览',
  planning: '科研计划',
  assets: '资产库',
  library: '文献库',
  paper: '论文',
  experiments: '实验',
  figures: '图表',
  meetings: '组会',
  venues: '会议',
  servers: '服务器',
  ledger: '记录',
  plugins: '插件',
  settings: '设置'
} as const

export type ModuleKey = keyof typeof MODULE_LABELS

/** 点击侧栏进入某模块，并等待其标题渲染完成。 */
export async function gotoModule(page: Page, module: ModuleKey): Promise<void> {
  await page.getByRole('button', { name: MODULE_LABELS[module], exact: true }).first().click()
  if (module === 'chat') {
    await expect(page.getByPlaceholder('今天帮你做些什么？输入 / 可调用技能与指令')).toBeVisible()
    return
  }
  // 等模块标题出现即视为切换完成（App.tsx 用 key 重挂载主内容）
  await expect(page.locator('.module-title').first()).toBeVisible()
}

/** 读取当前模块标题文本（.module-title），用于断言落在了正确的模块。 */
export async function currentModuleTitle(page: Page): Promise<string> {
  return (await page.locator('.module-title').first().innerText()).trim()
}

/** 断言当前处于某模块（按标题文本匹配）。 */
export async function expectModule(page: Page, titleContains: string): Promise<void> {
  await expect(page.locator('.module-title').first()).toContainText(titleContains)
}

export async function gotoResearchWritingMaterials(page: Page): Promise<void> {
  const entry = page.getByRole('button', { name: '研究问题与写作素材', exact: true })
  const writing = page.getByRole('button', { name: '写作素材', exact: true })
  const ready = page.getByRole('button', { name: '新建素材包', exact: true })
  const budget = 30_000
  const deadline = performance.now() + budget
  // 恢复还可能复用入口节点并改变点击语义；所有状态等待共用原30秒动作预算。
  await expect.poll(async () => {
    if (await ready.isVisible()) return true
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    try {
      await entry.or(writing).first().click({ timeout: Math.min(1000, remaining) })
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error
    }
    return ready.isVisible()
  }, { timeout: budget, intervals: [0, 100, 250], message: '研究导航未进入写作素材就绪状态' }).toBe(true)
}
