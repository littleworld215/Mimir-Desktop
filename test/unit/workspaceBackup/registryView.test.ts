import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
function home() { const root = mkdtempSync(join(tmpdir(), 'mimir-registry-view-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function subject() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/registryView.ts')).catch(() => ({} as any))
  expect(mod.readRegistryOverview).toBeTypeOf('function')
  return mod
}
it('只返回空间ID与名称，不泄露全局模型/服务器配置；文件逐字不变', async () => {
  const { readRegistryOverview } = await subject()
  const root = home(), control = join(root, '.mimir'); mkdirSync(control)
  const path = join(control, 'store.json')
  const bytes = JSON.stringify({ settings: { apiKey: 'synthetic-secret' }, 'servers:list': [{ password: 'synthetic-password' }], 'workspaces:list': [{ id: 'a', name: '合成空间', path: join(root, 'space') }], unknown: 'preserved' })
  writeFileSync(path, bytes)
  expect(readRegistryOverview(root)).toEqual([{ id: 'a', name: '合成空间' }])
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})
it('没有注册表时只返回空列表，不创建或迁移源文件', async () => {
  const { readRegistryOverview } = await subject()
  const root = home()
  expect(readRegistryOverview(root)).toEqual([])
  expect(existsSync(join(root, '.mimir'))).toBe(false)
})
it.each(['broken', '[]', '{"workspaces:list":[{}]}', '{"workspaces:list":{}}', '{"workspaces:list":[{"id":"a","name":"x","path":"relative"}]}'])('损坏注册表拒绝，不清空或重写 %s', async value => {
  const { readRegistryOverview } = await subject()
  const root = home(); mkdirSync(join(root, '.mimir'))
  const path = join(root, '.mimir/store.json'); writeFileSync(path, value)
  expect(() => readRegistryOverview(root)).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(value)
})
it('链接控制目录拒绝，不沿链接读取另一个注册表', async () => {
  const { readRegistryOverview } = await subject()
  const root = home(), other = home()
  writeFileSync(join(other, 'store.json'), '{}')
  symlinkSync(other, join(root, '.mimir'), 'junction')
  expect(() => readRegistryOverview(root)).toThrow()
})
it('悬空控制目录链接也拒绝，不能伪装为没有登记空间', async () => {
  const { readRegistryOverview } = await subject()
  const root = home(), other = home()
  symlinkSync(other, join(root, '.mimir'), 'junction')
  rmSync(other, { recursive: true })
  expect(() => readRegistryOverview(root)).toThrow()
})
