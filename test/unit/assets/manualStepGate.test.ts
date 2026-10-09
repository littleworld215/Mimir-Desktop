import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { createTempHome, type TempHome } from '../../../e2e/helpers/tempHome'
import { manualSessionTimeout, waitForManualStep } from '../../../e2e/helpers/manualStepGate'

const homes: TempHome[] = []
const file = () => { const home = createTempHome(); homes.push(home); return join(home.root, 'continue-1.txt') }
afterEach(() => { for (const home of homes.splice(0)) home.cleanup() })

it('单步整场预算覆盖七次等待和六次SDK响应，连续模式保持15分钟且单步有界', () => {
  expect(manualSessionTimeout(true)).toBeGreaterThanOrEqual(7 * 120_000 + 6 * 125_000 + 180_000)
  expect(manualSessionTimeout(true)).toBeLessThanOrEqual(30 * 60_000)
  expect(manualSessionTimeout(false)).toBe(15 * 60_000)
})

it('没有当前指令就暂停；只消费当前步骤，保留其他步骤文件', async () => {
  const path = file(), other = join(path, '..', 'continue-2.txt')
  writeFileSync(other, '2')
  let started = false
  const waiting = waitForManualStep(path, 1, { timeoutMs: 500, pollMs: 5 }).then(() => { started = true })
  await pause(15)
  expect(started).toBe(false)
  writeFileSync(path, '1\r\n')
  await waiting
  expect(started).toBe(true)
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(other, 'utf8')).toBe('2')
})

it('错误步骤或非法指令不继续、不删除，避免误发下一请求', async () => {
  const path = file()
  for (const value of ['2', 'yes', '1\n2', '']) {
    writeFileSync(path, value)
    await expect(waitForManualStep(path, 1)).rejects.toThrow('非当前步骤')
    expect(readFileSync(path, 'utf8')).toBe(value)
  }
})

it('等待有界，超时后晚到的指令不会被消费', async () => {
  const path = file()
  await expect(waitForManualStep(path, 1, { timeoutMs: 20, pollMs: 2 })).rejects.toThrow('超时')
  writeFileSync(path, '1')
  await pause(10)
  expect(readFileSync(path, 'utf8')).toBe('1')
})

it('取消不消费指令；无效步骤和预算在等待前拒绝', async () => {
  const path = file(), controller = new AbortController()
  writeFileSync(path, '1')
  controller.abort()
  await expect(waitForManualStep(path, 1, { signal: controller.signal })).rejects.toThrow('取消')
  expect(readFileSync(path, 'utf8')).toBe('1')
  for (const step of [0, 8, 1.5, NaN]) await expect(waitForManualStep(path, step)).rejects.toThrow('无效')
  for (const timeoutMs of [0, -1, Infinity, 120001]) await expect(waitForManualStep(path, 1, { timeoutMs })).rejects.toThrow('无效')
})

it('文件系统错误不当作未收到指令；等待中取消仍退出', async () => {
  const path = file()
  mkdirSync(path)
  await expect(waitForManualStep(path, 1)).rejects.toThrow()
  const controller = new AbortController()
  const waiting = waitForManualStep(`${path}.missing`, 1, { timeoutMs: 500, pollMs: 5, signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await expect(waiting).rejects.toThrow('取消')
})
