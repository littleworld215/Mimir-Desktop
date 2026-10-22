import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { createPaperLifecycleController } from '../library/paperLifecycle'
import { evidenceRuntime } from '../library/evidence/runtime'

const scope = z.object({ workspaceId: z.string().min(1).max(1000), spaceEpoch: z.string().min(1).max(1000) }).strict()
const schemas = {
  paperTrash: z.undefined(),
  previewPaperLifecycle: z.object({ scope, arxivId: z.string().min(1).max(1000), action: z.enum(['trash', 'restore']) }).strict(),
  applyPaperLifecycle: z.object({ scope, token: z.string().uuid() }).strict()
}
export function registerLibraryLifecycleHandlers({ windowRef }: { windowRef: { current: BrowserWindow | null } }) {
  const controller = createPaperLifecycleController()
  for (const action of Object.keys(schemas) as (keyof typeof schemas)[]) {
    ipcMain.handle('library:' + action, async (event, ...args: unknown[]) => {
      try {
        const win = windowRef.current, sender = event.sender
        if (!win || win.isDestroyed() || sender !== win.webContents || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) throw Error('仅允许工作台主窗口操作')
        if (args.length > (action === 'paperTrash' ? 0 : 1)) throw Error('请求参数无效')
        const parsed = schemas[action].safeParse(args[0])
        if (!parsed.success) throw Error('请求参数无效')
        if (action === 'paperTrash') return { ok: true, ...controller.overview() }
        if (action === 'previewPaperLifecycle') {
          const r = parsed.data as z.infer<typeof schemas.previewPaperLifecycle>
          return { ok: true, preview: controller.preview(r.scope, r.arxivId, r.action) }
        }
        const r = parsed.data as z.infer<typeof schemas.applyPaperLifecycle>
        await controller.apply(r.scope, r.token)
        evidenceRuntime.source.clearSourceObservations()
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '操作失败，原资料保留' }
      }
    })
  }
}
