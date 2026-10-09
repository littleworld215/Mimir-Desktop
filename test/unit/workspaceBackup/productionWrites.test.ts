import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestWorkspace, switchWorkspaceTo } from '../../stubs/store'
import { workspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'

const http = vi.hoisted(() => vi.fn())
vi.mock('../../../electron/http', () => ({ httpFetch: http }))
let home = '', first: ReturnType<typeof createTestWorkspace>, second: ReturnType<typeof createTestWorkspace>
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mimir-production-writes-'))
  first = createTestWorkspace('first', join(home, 'first')); second = createTestWorkspace('second', join(home, 'second'))
  mkdirSync(first.path); mkdirSync(second.path)
  switchWorkspaceTo(first.id)
  http.mockReset()
})
afterEach(() => {
  workspaceOperationGate.resume()
  if (!home.startsWith(join(tmpdir(), 'mimir-production-writes-'))) throw Error('unsafe cleanup')
  rmSync(home, { recursive: true, force: true })
})
const yaml = '- title: SYNTHETIC\n  confs:\n    - id: synthetic2026\n      year: 2026\n'
const pdf = new Uint8Array(Buffer.from('%PDF-1.4 synthetic'))
it('已接受任务在回调启动前切空间仍拒绝，不读取新的目标', async () => {
  const service = await import('../../../electron/venues/venuesService')
  http.mockResolvedValue(new Response(yaml))
  const task = service.refreshVenueDeadlines()
  switchWorkspaceTo(second.id)
  await expect(task).rejects.toThrow('切换')
  expect(http).not.toHaveBeenCalled()
  expect(existsSync(join(second.path, '.mimir'))).toBe(false)
})
it('会议刷新联网期间切空间，不能把旧结果写到新缓存', async () => {
  const service = await import('../../../electron/venues/venuesService')
  let finish!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  http.mockImplementation(async () => { started(); await new Promise<void>(resolve => { finish = resolve }); return new Response(yaml) })
  const task = service.refreshVenueDeadlines()
  await ready
  switchWorkspaceTo(second.id)
  finish()
  await expect(task).rejects.toThrow('切换')
  expect(existsSync(join(first.path, '.mimir/venue-deadlines.cache.json'))).toBe(false)
  expect(existsSync(join(second.path, '.mimir/venue-deadlines.cache.json'))).toBe(false)
})
it('会议真实缓存写入受排空跟踪，完成前排空不能成功', async () => {
  const service = await import('../../../electron/venues/venuesService')
  let finish!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  http.mockImplementation(async () => { started(); await new Promise<void>(resolve => { finish = resolve }); return new Response(yaml) })
  const task = service.refreshVenueDeadlines()
  await ready
  let drained = false
  const drain = workspaceOperationGate.drain(1000).then(() => { drained = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(drained).toBe(false)
  finish(); await task; await drain
  expect(JSON.parse(readFileSync(join(first.path, '.mimir/venue-deadlines.cache.json'), 'utf8')).venues[0].title).toBe('SYNTHETIC')
})
it('PDF下载期间切空间，拒绝在旧或新目录发布，不覆盖已有文件', async () => {
  const service = await import(/* @vite-ignore */ join(process.cwd(), 'electron/library/pdfDownload.ts')).catch(() => ({} as any))
  expect(service.downloadArxivPdf).toBeTypeOf('function')
  mkdirSync(join(first.path, 'papers'))
  const original = join(first.path, 'papers/2401.00001.pdf'); writeFileSync(original, 'original')
  let finish!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  http.mockImplementation(async () => { started(); await new Promise<void>(resolve => { finish = resolve }); return new Response(pdf) })
  const task = service.downloadArxivPdf('2401.00001')
  await ready; switchWorkspaceTo(second.id); finish()
  await expect(task).rejects.toThrow('切换')
  expect(readFileSync(original, 'utf8')).toBe('original')
  expect(existsSync(join(second.path, 'papers'))).toBe(false)
})
it('PDF真实临时文件发布后任务才结束且不遗留临时文件', async () => {
  const service = await import(/* @vite-ignore */ join(process.cwd(), 'electron/library/pdfDownload.ts')).catch(() => ({} as any))
  expect(service.downloadArxivPdf).toBeTypeOf('function')
  http.mockResolvedValue(new Response(pdf))
  const file = await service.downloadArxivPdf('2401.00001')
  expect(readFileSync(file)).toEqual(Buffer.from(pdf))
  expect(readdirSync(join(first.path, 'papers'))).toEqual(['2401.00001.pdf'])
  expect(workspaceOperationGate.pendingCount).toBe(0)
})
