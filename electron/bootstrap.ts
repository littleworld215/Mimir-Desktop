import { dispatchStartup } from './workspaceBackup/dispatch'
import { startupMode } from './workspaceBackup/startupMode'
import { app, dialog, protocol } from 'electron'

void (async () => {
  // 动态import的等待会让app进入ready，特权协议必须在这个同步前缀注册。
  if (startupMode(process.argv) === 'normal') protocol.registerSchemesAsPrivileged([
    { scheme: 'mimir-pdf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: 'mimir-tex', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: 'mimir-img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
  await dispatchStartup(process.argv, {
    normal: () => import('./main'),
    maintenance: () => import('./workspaceBackup/maintenanceMain')
  })
})().catch(async () => {
  await app.whenReady()
  dialog.showErrorBox('Mimir启动未完成', '启动模式冲突或入口加载失败；未启动维护操作。请关闭其它实例后使用正确的启动参数。')
  app.exit(1)
})
