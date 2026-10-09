import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'
import { workspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
const http = vi.hoisted(() => vi.fn())
vi.mock('../../../electron/http', () => ({ httpFetch: http }))
let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mimir-producer-stop-'))
  const space = createTestWorkspace('stop', root); switchWorkspaceTo(space.id)
  http.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  workspaceOperationGate.resume()
  if (!root.startsWith(join(tmpdir(), 'mimir-producer-stop-'))) throw Error('unsafe cleanup')
  rmSync(root, { recursive: true, force: true })
})
it('会议停止清除两种定时器，取消联网仍等待实际结束并保留旧缓存', async () => {
  const service = await import('../../../electron/venues/venuesService')
  mkdirSync(join(root, '.mimir')); const cache = join(root, '.mimir/venue-deadlines.cache.json')
  writeFileSync(cache, 'old cache')
  let finish!: () => void, started!: () => void, signal!: AbortSignal
  const ready = new Promise<void>(resolve => { started = resolve })
  http.mockImplementation(async (_url, options) => {
    signal = options.signal; started(); await new Promise<void>(resolve => { finish = resolve })
    return new Response('- title: SYNTHETIC\n  confs:\n    - id: s2026\n      year: 2026\n')
  })
  vi.useFakeTimers(); service.startVenueDeadlineLoop()
  expect(vi.getTimerCount()).toBe(2)
  const task = service.refreshVenueDeadlines(); const rejected = expect(task).rejects.toThrow()
  await ready
  let stopped = false
  const stop = service.stopVenueDeadlineLoop().finally(() => { stopped = true })
  const stopRejected = expect(stop).rejects.toThrow('收口')
  await Promise.resolve()
  expect(signal.aborted).toBe(true); expect(stopped).toBe(false)
  // 唯一剩余的计时器属于已接受请求的原网络超时。
  expect(vi.getTimerCount()).toBe(1)
  finish(); await rejected; await stopRejected
  expect(vi.getTimerCount()).toBe(0)
  expect(readFileSync(cache, 'utf8')).toBe('old cache')
  expect(readdirSync(join(root, '.mimir'))).toEqual(['venue-deadlines.cache.json'])
  await expect(service.refreshVenueDeadlines()).rejects.toThrow('关闭')
})
it('PDF停止等待下载实际结束，不发布结果、不覆盖旧文件', async () => {
  const service = await import('../../../electron/library/pdfDownload')
  const { workspaceDownloadTasks } = await import('../../../electron/workspaceBackup/productionTasks')
  mkdirSync(join(root, 'papers')); const file = join(root, 'papers/2401.00001.pdf'); writeFileSync(file, 'old PDF')
  let finish!: () => void, started!: () => void, signal!: AbortSignal
  const ready = new Promise<void>(resolve => { started = resolve })
  http.mockImplementation(async (_url, options) => {
    signal = options.signal; started(); await new Promise<void>(resolve => { finish = resolve })
    return new Response('%PDF-1.4 synthetic')
  })
  const task = service.downloadArxivPdf('2401.00001'); const rejected = expect(task).rejects.toThrow()
  await ready
  let stopped = false
  const stop = workspaceDownloadTasks.stop().finally(() => { stopped = true })
  const stopRejected = expect(stop).rejects.toThrow('收口')
  await Promise.resolve(); expect(signal.aborted).toBe(true); expect(stopped).toBe(false)
  finish(); await rejected; await stopRejected
  expect(readFileSync(file, 'utf8')).toBe('old PDF')
  expect(readdirSync(join(root, 'papers'))).toEqual(['2401.00001.pdf'])
  await expect(service.downloadArxivPdf('2401.00001')).rejects.toThrow('关闭')
})
