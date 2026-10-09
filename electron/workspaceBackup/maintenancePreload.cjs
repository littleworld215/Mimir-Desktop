// Sandbox preload仅依赖Electron白名单模块，不加载普通API或本地业务文件。
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('workspaceBackupMaintenance', Object.freeze({
  overview: () => ipcRenderer.invoke('workspaceBackup:overview')
}))
