// Sandbox preload仅依赖Electron白名单模块，不加载普通API或本地业务文件。
//
// 通道名必须与 `shared/workspaceBackupContracts.ts` 的 `WORKSPACE_BACKUP_CHANNELS` 保持
// 字节一致：sandbox preload 无法加载 TS 契约，只能硬编码字符串（见 electron.vite.config.ts
// 里 `maintenance-sandbox-preload` 的说明——本文件以自包含 CJS 进入沙箱 preload）。
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('workspaceBackupMaintenance', Object.freeze({
  overview: () => ipcRenderer.invoke('workspaceBackup:overview'),
  recoveryList: cursor => ipcRenderer.invoke('workspaceBackup:recoveryList', cursor),
  recoveryAction: request => ipcRenderer.invoke('workspaceBackup:recoveryAction', request),
  // 恢复：请求体形如 { archivePath, targetRoot, spaceName }（字段**只作输入**，
  // 主进程自行 path.resolve 规范化并校验，绝不信任渲染层拼好的路径 —— 设计 §4.2 S7）。
  restore: request => ipcRenderer.invoke('workspaceBackup:restore', request),
  // 恢复进度订阅（可选增强）：返回取消订阅函数，避免组件卸载后监听器泄漏。
  // 只把 (event, progress) 的 progress 透传给渲染层，不暴露 IpcRendererEvent（含 sender）。
  onRestoreProgress: listener => {
    const wrapped = (_event, progress) => listener(progress)
    ipcRenderer.on('workspaceBackup:restoreProgress', wrapped)
    return () => { ipcRenderer.removeListener('workspaceBackup:restoreProgress', wrapped) }
  },
  // 只读自检（I6 批次 4 · T04）：请求体为最保守形态（空对象），主进程自行推导 home，
  // 绝不接受渲染层拼的任意路径（对齐 restore 的输入纪律）。
  doctor: () => ipcRenderer.invoke('workspaceBackup:doctor'),
  // 自检进度订阅（可选增强）：形态同 onRestoreProgress（只透传 progress，不暴露 IpcRendererEvent）。
  onDoctorProgress: listener => {
    const wrapped = (_event, progress) => listener(progress)
    ipcRenderer.on('workspaceBackup:doctorProgress', wrapped)
    return () => { ipcRenderer.removeListener('workspaceBackup:doctorProgress', wrapped) }
  },
  // 取消自检（只读取消）/ 取消恢复（信号语义）：本批如实返回 { ok:false, code:'NOT_SUPPORTED' }。
  cancelDoctor: () => ipcRenderer.invoke('workspaceBackup:doctorCancel'),
  cancelRestore: () => ipcRenderer.invoke('workspaceBackup:restoreCancel'),
  // 读取最近维护审计（只读；返回已脱敏条目，不暴露 JSONL 文件路径）。
  auditRecent: limit => ipcRenderer.invoke('workspaceBackup:auditRecent', limit),
  // 保留策略预览（I6 批次 5 · T04；只读 dry-run）：返回脱敏视图（只含文件名 / 大小 / 时间 /
  // 保留或清理标记 + 一次性 confirmToken），**绝不含绝对路径**。
  retentionPreview: () => ipcRenderer.invoke('workspaceBackup:retentionPreview'),
  // 保留策略确认清理（写路径）：入参**只有一个** { confirmToken }（来自上一次预览）——
  // **绝不回传文件列表**：主进程据 token 自己重算候选，渲染层不得指定删除目标（设计 §2.2 / K2）。
  applyRetention: (token) => ipcRenderer.invoke('workspaceBackup:retentionApply', { confirmToken: token }),
  // 逐空间完整备份（I6 批次 3.5 · T04；写路径）：入参**只有一个** { spaceId }（来自只读清单）——
  // **绝不由渲染层回传路径**：主进程据 spaceId 自己从只读注册表重解析空间根（设计 §1.1 / K4）。
  backupSpace: (request) => ipcRenderer.invoke('workspaceBackup:backupSpace', request),
  // 备份进度订阅（可选增强）：形态同 onRestoreProgress / onDoctorProgress（只透传 progress，
  // 不暴露 IpcRendererEvent）。返回取消订阅函数，避免组件卸载后监听器泄漏。
  onBackupProgress: listener => {
    const wrapped = (_event, progress) => listener(progress)
    ipcRenderer.on('workspaceBackup:backupProgress', wrapped)
    return () => { ipcRenderer.removeListener('workspaceBackup:backupProgress', wrapped) }
  }
}))
