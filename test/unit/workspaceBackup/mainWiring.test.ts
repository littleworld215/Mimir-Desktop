import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 普通 main 的 I6 装配是「运行时才生效」的，单元测试无法加载 Electron 主进程。
 * 这里用源码契约检查保证装配不会在后续重构中被悄悄移除或改回同步停止——
 * 一旦退化，维护交接会在生产者未收口时授予，形成「虚假交接安全」。
 */
const source = () => readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8')

it('普通启动以受保护初始化持有写者会话，而非裸 loadStore()', () => {
  const src = source()
  expect(src).toContain('new WorkspaceWriterSession(')
  expect(src).toContain('loadStore(writerSession)')
  expect(src).toContain('installWorkspaceOperationProtection(workspaceOperationGate)')
  expect(src).toContain('installWorkspaceIpcGate(ipcMain')
})

it('维护交接的生产者停止使用「停止并等待」接口，不用同步 abort', () => {
  const src = source()
  expect(src).toContain('stopAllAgentTasksAndWait()')
  expect(src).toContain('stopAllAssetsAiTasksAndWait()')
  expect(src).toContain('stopVenueDeadlineLoop()')
  // 交付口必须在排空之后单独释放，不能被通用 3 秒预算截断。
  expect(src).toContain('writerSession?.close()')
})

it('维护入口经状态机推进，且窗口关闭时回退普通退出防止僵尸进程', () => {
  const src = source()
  expect(src).toContain('installWorkspaceMaintenanceHandler(ipcMain')
  expect(src).toContain("maintenanceHandoff.state === 'requested'")
  expect(src).toContain('quitFlow.windowClosed()')
})
it('研究组织在维护交接和普通退出均等待实际任务结束', () => {
  expect(source().match(/stopResearchTasksAndWait\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
})
