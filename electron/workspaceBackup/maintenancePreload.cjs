// Sandbox preload仅依赖Electron白名单模块，不加载普通API或本地业务文件。
//
// 通道名必须与 `shared/workspaceBackupContracts.ts` 的 `WORKSPACE_BACKUP_CHANNELS` 保持
// 字节一致：sandbox preload 无法加载 TS 契约，只能硬编码字符串（见 electron.vite.config.ts
// 里 `maintenance-sandbox-preload` 的说明——本文件以自包含 CJS 进入沙箱 preload）。
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('workspaceBackupMaintenance', Object.freeze({
  overview: () => ipcRenderer.invoke('workspaceBackup:overview'),
  // 恢复：请求体形如 { archivePath, targetRoot, spaceName }（字段**只作输入**，
  // 主进程自行 path.resolve 规范化并校验，绝不信任渲染层拼好的路径 —— 设计 §4.2 S7）。
  restore: request => ipcRenderer.invoke('workspaceBackup:restore', request),
  // 恢复进度订阅（可选增强）：返回取消订阅函数，避免组件卸载后监听器泄漏。
  // 只把 (event, progress) 的 progress 透传给渲染层，不暴露 IpcRendererEvent（含 sender）。
  onRestoreProgress: listener => {
    const wrapped = (_event, progress) => listener(progress)
    ipcRenderer.on('workspaceBackup:restoreProgress', wrapped)
    return () => { ipcRenderer.removeListener('workspaceBackup:restoreProgress', wrapped) }
  }
}))
