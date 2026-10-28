// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { copyAssetText } from '../../../src/components/modules/assets/assetClipboard'
import { takeAndRecord } from '../../../src/components/modules/assets/assetTake'

afterEach(() => vi.restoreAllMocks())
function clipboard(readText = vi.fn().mockResolvedValue('')) {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } })
  return { writeText, readText }
}

it.each([
  ['', ''],
  [' 原文😀\n\n', ' 原文😀\r\n\r\n'],
  ['混合\r\n\n换行\r保留', '混合\r\n\r\n换行\r保留'],
  ['https://example.org/research', 'https://example.org/research']
])('写入原始字节，仅核对时兼容换行：%j', async (text, actual) => {
  const api = clipboard(vi.fn().mockResolvedValue(actual))
  await expect(copyAssetText(text)).resolves.toBeUndefined()
  expect(api.writeText).toHaveBeenCalledTimes(1)
  expect(api.writeText).toHaveBeenCalledWith(text)
  expect(api.readText).toHaveBeenCalledTimes(1)
})

it.each([
  [' 空白 ', '空白'],
  ['两行\n\n', '两行\n'],
  ['é', 'e\u0301']
])('不忽略空白、空行或Unicode差异：%j', async (text, actual) => {
  const api = clipboard(vi.fn().mockResolvedValue(actual))
  await expect(copyAssetText(text)).rejects.toThrow('未能确认剪贴板内容，请重试。')
  expect(api.writeText).toHaveBeenCalledTimes(1)
  expect(api.readText).toHaveBeenCalledTimes(1)
})

it('写入拒绝不读取、不重试', async () => {
  const api = clipboard()
  api.writeText.mockRejectedValue(Error('write denied'))
  await expect(copyAssetText('正文')).rejects.toThrow('write denied')
  expect(api.writeText).toHaveBeenCalledTimes(1)
  expect(api.readText).not.toHaveBeenCalled()
})

it('回读拒绝使用固定提示，不泄漏原错误，不写日志', async () => {
  const log = vi.spyOn(console, 'log'), error = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn')
  clipboard(vi.fn().mockRejectedValue(Error('不可输出的回读内容')))
  await expect(copyAssetText('正文')).rejects.toEqual(Error('无法核验剪贴板内容，请重试。'))
  expect(log).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

it('不支持读取时不能报告成功', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await expect(copyAssetText('正文')).rejects.toThrow('无法核验剪贴板内容，请重试。')
  expect(writeText).toHaveBeenCalledTimes(1)
})

it('回读未完成前不记录使用，成功后只记录一次', async () => {
  let resolve!: (value: string) => void
  const api = clipboard(vi.fn(() => new Promise<string>(done => { resolve = done })))
  const record = vi.fn().mockResolvedValue(undefined)
  const result = takeAndRecord(async () => { await copyAssetText('正文'); return true }, record)
  await vi.waitFor(() => expect(api.readText).toHaveBeenCalledTimes(1))
  expect(record).not.toHaveBeenCalled()
  resolve('正文')
  await expect(result).resolves.toBe('取用成功。')
  expect(record).toHaveBeenCalledTimes(1)
})

it('静默失败不记录；只有调用方明确再次复制才重新尝试', async () => {
  const api = clipboard(vi.fn().mockResolvedValueOnce('旧内容').mockResolvedValue('正文'))
  const record = vi.fn().mockResolvedValue(undefined)
  const take = () => takeAndRecord(async () => { await copyAssetText('正文'); return true }, record)
  await expect(take()).rejects.toThrow('未能确认剪贴板内容，请重试。')
  expect(api.writeText).toHaveBeenCalledTimes(1)
  expect(record).not.toHaveBeenCalled()
  await expect(take()).resolves.toBe('取用成功。')
  expect(api.writeText).toHaveBeenCalledTimes(2)
  expect(record).toHaveBeenCalledTimes(1)
})
