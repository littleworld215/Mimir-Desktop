import { ipcMain } from 'electron'
import {
  createWorkspace,
  getActiveWorkspace,
  getDefaultWorkspace,
  listWorkspaces,
  removeWorkspace,
  renameWorkspace,
  setDefaultWorkspace,
  switchWorkspace
} from '../library/store'
import type { AssertRendererPath } from './guards'
import { assetsStoreManager } from '../assets/store'

/** 科研空间：列表 / 创建 / 重命名 / 移除 / 切换 / 设默认（`workspaces:*`）。 */
export function registerWorkspacesHandlers(deps: { assertRendererPath: AssertRendererPath }): void {
  const { assertRendererPath } = deps

  ipcMain.handle('workspaces:list', async () => {
    try {
      const workspaces = listWorkspaces()
      const activeId = getActiveWorkspace()?.id ?? null
      const defaultId = getDefaultWorkspace()?.id ?? null
      return { ok: true, workspaces, activeId, defaultId }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:current', async () => {
    try {
      const active = getActiveWorkspace()
      return { ok: true, active: active === null ? null : { ...active } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '读取当前空间失败' }
    }
  })

  ipcMain.handle('workspaces:create', async (_event, name: string, dir?: string) => {
    // 空间根是用户自选的目录（缺省 ~/Mimir/<名称>）；显式传入时按写边界校验。
    const target = dir === undefined || dir === '' ? undefined : assertRendererPath(dir, 'write')
    try {
      await assetsStoreManager.beforeSpaceSwitch()
    } catch (error) {
      assetsStoreManager.afterSpaceSwitch()
      return { ok: false, message: `资产库未能安全关闭，未创建科研空间：${error instanceof Error ? error.message : '未知错误'}` }
    }
    try {
      const workspace = createWorkspace(name, target)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      // 空间注册是全局写 + 空间层缓存的两步：失败不得假装成功（半切换对资产库是写错库）。
      return { ok: false, message: error instanceof Error ? error.message : '创建科研空间失败', inconsistent: true }
    } finally {
      assetsStoreManager.afterSpaceSwitch()
    }
  })

  ipcMain.handle('workspaces:rename', async (_event, id: string, name: string) => {
    try {
      const workspace = renameWorkspace(id, name)
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '重命名失败' }
    }
  })

  ipcMain.handle('workspaces:remove', async (_event, id: string) => {
    try {
      removeWorkspace(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '移除科研空间失败' }
    }
  })

  ipcMain.handle('workspaces:switch', async (_event, id: string) => {
    // 排空 / 关库失败时不进入切换：否则会以旧库连接写新空间。
    try {
      await assetsStoreManager.beforeSpaceSwitch()
    } catch (error) {
      assetsStoreManager.afterSpaceSwitch()
      return { ok: false, message: `资产库未能安全关闭，未切换科研空间：${error instanceof Error ? error.message : '未知错误'}` }
    }
    try {
      const workspace = switchWorkspace(id)
      // 持久化指针失败或顺序异常会留下「内存已切 / 磁盘未切」：显式暴露不一致，由用户重启后重试。
      if (getActiveWorkspace()?.id !== workspace.id) {
        return { ok: false, message: '切换未生效：科研空间指针与内存状态不一致，请重启应用后重试。', inconsistent: true }
      }
      return { ok: true, workspace: { ...workspace } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '切换科研空间失败', inconsistent: true }
    } finally {
      // 无论成功失败都恢复入口：失败时旧连接已关闭，当前可信空间可按需重开。
      assetsStoreManager.afterSpaceSwitch()
    }
  })

  ipcMain.handle('workspaces:setDefault', async (_event, id: string) => {
    try {
      setDefaultWorkspace(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '设置默认空间失败' }
    }
  })
}
