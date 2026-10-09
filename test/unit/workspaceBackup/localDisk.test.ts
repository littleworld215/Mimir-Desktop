import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })
async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/localDisk.ts')).catch(() => ({} as any))
  expect(mod.assertWindowsLocalDisk).toBeTypeOf('function')
  return mod
}
it.each(['\\\\server\\share\\space', '\\\\?\\C:\\space', 'relative', 'C:relative'])('拒绝网络/设备/相对根 %s，不调用原生探针', async root => {
  const { assertWindowsLocalDisk } = await moduleUnderTest()
  let called = false
  expect(() => assertWindowsLocalDisk(root, () => { called = true; return 3 })).toThrow()
  expect(called).toBe(false)
})
it.each([0, 1, 4, 5, 6])('拒绝未知、网络和非磁盘卷类型 %s', async driveType => {
  const { assertWindowsLocalDisk } = await moduleUnderTest()
  expect(() => assertWindowsLocalDisk('C:\\synthetic', () => driveType)).toThrow('NOT_LOCAL_DISK')
})
it('原生本机检查实际读取Windows卷信息，不生成源空间控制文件', async () => {
  const { assertWindowsLocalDisk } = await moduleUnderTest()
  if (process.platform !== 'win32') {
    expect(() => assertWindowsLocalDisk('/tmp')).toThrow()
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'mimir-本机卷-')); roots.push(root)
  expect(() => assertWindowsLocalDisk(root)).not.toThrow()
  expect(readdirSync(root)).toEqual([])
  expect(existsSync(join(root, '.mimir'))).toBe(false)
})
it('原生探针失败不得按盘符猜测或默认为本机磁盘', async () => {
  const { assertWindowsLocalDisk } = await moduleUnderTest()
  expect(() => assertWindowsLocalDisk('C:\\synthetic', () => { throw Error('PROBE_FAILED') })).toThrow('PROBE_FAILED')
})
