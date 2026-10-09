import { expect, it } from 'vitest'
import { join } from 'node:path'

async function moduleUnderTest() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/archivePaths.ts')).catch(() => ({} as any))
  expect(mod.validateArchivePaths).toBeTypeOf('function')
  return mod
}

it.each(['../escape', 'space/../../x', '/absolute', 'C:/device', '//server/share', '\\\\?\\C:\\x', 'space\\escape', 'space/a:b', 'space/a\0b', 'space/a./x', 'space/a /x', 'space/CON.txt', 'space/com1', 'space/LPT9.ext', 'space/COM¹.txt', 'space//x', 'space/./x'])('拒绝不安全或不可移植路径 %s', async path => {
  const { validateArchivePaths } = await moduleUnderTest()
  expect(() => validateArchivePaths([{ path, kind: 'file' }])).toThrow()
})

it('Unicode隐藏文件、空目录和正常项目资料路径保持原样', async () => {
  const { validateArchivePaths } = await moduleUnderTest()
  expect(() => validateArchivePaths([
    { path: 'space/.git/objects', kind: 'directory' },
    { path: 'space/资料/中文.pdf', kind: 'file' },
    { path: 'space/.env', kind: 'file' }
  ])).not.toThrow()
})

it.each([
  [{ path: 'space/A.txt', kind: 'file' }, { path: 'space/a.txt', kind: 'file' }],
  [{ path: 'space/A/x', kind: 'file' }, { path: 'space/a/y', kind: 'file' }],
  [{ path: 'space/a', kind: 'file' }, { path: 'space/a/b', kind: 'file' }],
  [{ path: 'space/a/b', kind: 'file' }, { path: 'space/a', kind: 'file' }],
  [{ path: 'space/a', kind: 'directory' }, { path: 'space/a', kind: 'directory' }]
])('拒绝重复、大小写目录歧义及文件目录冲突', async entries => {
  const { validateArchivePaths } = await moduleUnderTest()
  expect(() => validateArchivePaths(entries)).toThrow()
})
