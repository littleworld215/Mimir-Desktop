import { mkdir, writeFile, unlink } from 'fs/promises'
import { renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { assertSpaceUnchanged } from './store'
import { fetchArxivPdf, paperPdfFileName } from './arxiv'
import { workspaceDownloadTasks } from '../workspaceBackup/productionTasks'
import { workspaceOperationGate } from '../workspaceBackup/operationGate'

/** 固定来源空间；取消或切换后不发布下载结果。沿用已有 PDF 验证与大小限制。 */
export async function downloadArxivPdf(id: string): Promise<string> {
  const cleanId = id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
  if (cleanId === '' || !/^[a-zA-Z0-9._/-]+$/.test(cleanId)) throw new Error('无效的 arXiv id')
  return workspaceDownloadTasks.run(async cancelSignal => {
    const scope = workspaceOperationGate.current()!
    const epoch = scope.epoch
    const dir = join(scope.root, 'papers')
    const filePath = join(dir, paperPdfFileName(cleanId))
    const signal = AbortSignal.any([cancelSignal, AbortSignal.timeout(60_000)])
    const check = (): void => { signal.throwIfAborted(); assertSpaceUnchanged(epoch) }
    check()
    const bytes = await fetchArxivPdf(cleanId, signal)
    check()
    await mkdir(dir, { recursive: true })
    const tempPath = join(dir, `${randomUUID()}.tmp`)
    try {
      check()
      await writeFile(tempPath, bytes, { flag: 'wx' })
      check()
      // 校验和短小原子发布之间不让事件循环处理取消/切换。
      renameSync(tempPath, filePath)
      return filePath
    } finally {
      await unlink(tempPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    }
  })
}
