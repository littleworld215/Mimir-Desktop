import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'
const hooks = vi.hoisted(() => ({ afterWrite: undefined as (() => void) | undefined, asyncRename: vi.fn() }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => { await actual.writeFile(...args); hooks.afterWrite?.() },
    rename: async () => { hooks.asyncRename(); throw Error('异步发布存在任务切换窗口') },
  }
})
const http = vi.hoisted(() => vi.fn())
vi.mock('../../../electron/http', () => ({ httpFetch: http }))
let root = '', second: ReturnType<typeof createTestWorkspace>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mimir-publication-'))
  const first = createTestWorkspace('publish', join(root, 'first')); second = createTestWorkspace('other', join(root, 'second'))
  mkdirSync(first.path); mkdirSync(second.path); switchWorkspaceTo(first.id)
  hooks.afterWrite = undefined; hooks.asyncRename.mockClear(); http.mockReset()
})
afterEach(() => {
  hooks.afterWrite = undefined
  if (!root.startsWith(join(tmpdir(), 'mimir-publication-'))) throw Error('unsafe cleanup')
  rmSync(root, { recursive: true, force: true })
})
it('PDF最终发布不交给异步rename，校验与发布保持单个主线程执行段', async () => {
  const { downloadArxivPdf } = await import('../../../electron/library/pdfDownload')
  http.mockResolvedValue(new Response('%PDF-1.4 synthetic'))
  const file = await downloadArxivPdf('2401.00001')
  expect(readFileSync(file, 'utf8')).toBe('%PDF-1.4 synthetic')
  expect(hooks.asyncRename).not.toHaveBeenCalled()
})
it('缓存最终发布不交给异步rename', async () => {
  const { refreshVenueDeadlines } = await import('../../../electron/venues/venuesService')
  http.mockResolvedValue(new Response('- title: SYNTHETIC\n  confs:\n    - id: s2026\n      year: 2026\n'))
  await refreshVenueDeadlines()
  expect(JSON.parse(readFileSync(join(root, 'first/.mimir/venue-deadlines.cache.json'), 'utf8')).venues[0].title).toBe('SYNTHETIC')
  expect(hooks.asyncRename).not.toHaveBeenCalled()
})
it('PDF临时文件写完后切换，发布前再次校验并清理临时文件', async () => {
  const { downloadArxivPdf } = await import('../../../electron/library/pdfDownload')
  mkdirSync(join(root, 'first/papers')); const file = join(root, 'first/papers/2401.00001.pdf'); writeFileSync(file, 'old')
  http.mockResolvedValue(new Response('%PDF-1.4 synthetic'))
  hooks.afterWrite = () => switchWorkspaceTo(second.id)
  await expect(downloadArxivPdf('2401.00001')).rejects.toThrow('切换')
  expect(readFileSync(file, 'utf8')).toBe('old')
  expect(readdirSync(join(root, 'first/papers'))).toEqual(['2401.00001.pdf'])
})
