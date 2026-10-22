import { beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { registerLibraryLifecycleHandlers } from '../../electron/ipc/libraryLifecycle'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) } }))
let closed = false
const sender = { mainFrame: {}, isDestroyed: () => closed }
const event = { sender, senderFrame: sender.mainFrame }
beforeEach(() => {
  handlers.clear(); closed = false
  registerLibraryLifecycleHandlers({ windowRef: { current: { webContents: sender, isDestroyed: () => closed } as unknown as BrowserWindow } })
})
it('只登记固定三通道；只有主窗口主框架可以读取或预览', async () => {
  expect([...handlers.keys()].sort()).toEqual(['library:applyPaperLifecycle', 'library:paperTrash', 'library:previewPaperLifecycle'])
  for (const fake of [{}, { sender: {} }, { sender, senderFrame: {} }]) {
    expect(await handlers.get('library:paperTrash')!(fake)).toMatchObject({ ok: false })
  }
  expect(await handlers.get('library:paperTrash')!(event)).toMatchObject({ ok: true, papers: [] })
  closed = true
  expect(await handlers.get('library:paperTrash')!(event)).toMatchObject({ ok: false })
})
it('畸形、额外或任意路径请求拒绝；伪造执行令牌不能写入', async () => {
  const overview = await handlers.get('library:paperTrash')!(event)
  for (const request of [null, { path: 'C:/arbitrary' }, { scope: overview.scope, token: 'fake' }, { scope: overview.scope, token: '00000000-0000-4000-8000-000000000000', path: 'x' }]) {
    expect(await handlers.get('library:applyPaperLifecycle')!(event, request)).toMatchObject({ ok: false })
  }
  expect(await handlers.get('library:paperTrash')!(event, {})).toMatchObject({ ok: false })
  expect(await handlers.get('library:previewPaperLifecycle')!(event, { scope: overview.scope, arxivId: '', action: 'trash' })).toMatchObject({ ok: false })
})
