import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceWriterSession } from '../../../electron/workspaceBackup/writerSession'

const state = vi.hoisted(() => ({ home: '', failRename: false, failUnlink: false, failOldUnlink: false }))
vi.mock('os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }))
vi.mock('electron', () => ({ app: { getPath: () => join(state.home, 'profile') } }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: (a: string, b: string) => {
    if (state.failRename && b === join(state.home, '.mimir/store.json')) { state.failRename = false; throw Error('synthetic pointer write failure') }
    fs.renameSync(a, b)
  }, unlinkSync: (path: string) => {
    if (state.failOldUnlink && path === join(state.home, 'a/.mimir/workspace.writer-lock')) { state.failOldUnlink = false; throw Error('synthetic commit failure') }
    if (state.failUnlink && path === join(state.home, 'b/.mimir/workspace.writer-lock')) { state.failUnlink = false; throw Error('synthetic rollback failure') }
    fs.unlinkSync(path)
  } }
})
let session: WorkspaceWriterSession | undefined
afterEach(() => {
  state.failRename = false; state.failUnlink = false; state.failOldUnlink = false
  session?.close(); session = undefined
  if (state.home.startsWith(join(tmpdir(), 'mimir-real-store-switch-'))) rmSync(state.home, { recursive: true, force: true })
})
async function fixture(install = true) {
  state.home = mkdtempSync(join(tmpdir(), 'mimir-real-store-switch-'))
  for (const path of ['.mimir', 'a/.mimir', 'b/.mimir']) mkdirSync(join(state.home, path), { recursive: true })
  const first = join(state.home, 'a'), second = join(state.home, 'b')
  writeFileSync(join(first, '.mimir/store.json'), '{"custom":"first"}')
  writeFileSync(join(second, '.mimir/store.json'), '{"custom":"second"}')
  writeFileSync(join(state.home, '.mimir/store.json'), JSON.stringify({ activeWorkspaceId: 'a', defaultWorkspaceId: 'a', 'workspaces:list': [
    { id: 'a', name: 'A', path: first }, { id: 'b', name: 'B', path: second }
  ] }))
  vi.resetModules()
  // Absolute import bypasses the ordinary test store alias: exercise the real disk implementation.
  const store = await import(/* @vite-ignore */ join(process.cwd(), 'electron/library/store.ts'))
  store.loadStore()
  session = new WorkspaceWriterSession(state.home, () => {})
  session.select(first)
  if (install) store.installWorkspaceSwitchProtection(session)
  return { store, first, second, registry: join(state.home, '.mimir/store.json') }
}
it('真实store指针保存失败还原缓存/代际，保留旧锁并回滚新锁', async () => {
  const { store, first, second, registry } = await fixture()
  const bytes = readFileSync(registry, 'utf8'), epoch = store.currentSpaceEpoch()
  state.failRename = true
  expect(() => store.switchWorkspace('b')).toThrow('pointer write failure')
  expect(readFileSync(registry, 'utf8')).toBe(bytes)
  expect(store.currentSpaceEpoch()).toBe(epoch)
  expect(store.getStoreValue('custom')).toBe('first')
  expect(existsSync(join(first, '.mimir/workspace.writer-lock'))).toBe(true)
  expect(existsSync(join(second, '.mimir/workspace.writer-lock'))).toBe(false)
})
it('真实store成功切换提交指针/缓存/代际后释放旧锁，新空间可保存', async () => {
  const { store, first, second, registry } = await fixture()
  const epoch = store.currentSpaceEpoch()
  store.switchWorkspace('b')
  expect(JSON.parse(readFileSync(registry, 'utf8')).activeWorkspaceId).toBe('b')
  expect(store.currentSpaceEpoch()).not.toBe(epoch)
  expect(store.getStoreValue('custom')).toBe('second')
  expect(existsSync(join(first, '.mimir/workspace.writer-lock'))).toBe(false)
  expect(existsSync(join(second, '.mimir/workspace.writer-lock'))).toBe(true)
  store.setStoreValue('custom', 'saved')
  expect(JSON.parse(readFileSync(join(second, '.mimir/store.json'), 'utf8')).custom).toBe('saved')
})
it('回滚锁清理失败阻断后续全局/空间写入和切换，不伪装安全恢复', async () => {
  const { store, registry } = await fixture()
  const bytes = readFileSync(registry, 'utf8')
  state.failRename = true; state.failUnlink = true
  expect(() => store.switchWorkspace('b')).toThrow()
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
  expect(() => store.setStoreValue('settings', { changed: true })).toThrow()
  expect(() => store.switchWorkspace('b')).toThrow()
  expect(readFileSync(registry, 'utf8')).toBe(bytes)
})
it('会话关闭后store不能继续写；禁止替换已安装保护', async () => {
  const { store } = await fixture()
  expect(() => store.installWorkspaceSwitchProtection(session!)).toThrow()
  session!.close()
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
  expect(store.getStoreValue('custom')).toBe('first')
})
it('指针已成功保存但旧锁释放失败时阻断后续写入，不伪装磁盘回滚', async () => {
  const { store, registry } = await fixture()
  state.failOldUnlink = true
  expect(() => store.switchWorkspace('b')).toThrow('commit failure')
  expect(JSON.parse(readFileSync(registry, 'utf8')).activeWorkspaceId).toBe('b')
  expect(store.getActiveWorkspace()?.id).toBe('b')
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
  expect(() => store.switchWorkspace('a')).toThrow()
})
it('保护失效后默认/注册管理在改内存或创建目录前拒绝', async () => {
  const { store, registry } = await fixture()
  const before = readFileSync(registry, 'utf8')
  session!.close()
  expect(() => store.setDefaultWorkspace('b')).toThrow()
  expect(() => store.renameWorkspace('b', 'changed')).toThrow()
  expect(() => store.removeWorkspace('b')).toThrow()
  const dir = join(state.home, 'uncreated')
  expect(() => store.createWorkspace('new', dir)).toThrow()
  expect(existsSync(dir)).toBe(false)
  expect(store.getDefaultWorkspace()?.id).toBe('a')
  expect(store.listWorkspaces().find((space: { id: string }) => space.id === 'b')?.name).toBe('B')
  expect(readFileSync(registry, 'utf8')).toBe(before)
})
it('当前空间锁正确但注册表锁属于另一个HOME时拒绝安装', async () => {
  const { store, first, registry } = await fixture(false)
  const before = readFileSync(registry, 'utf8')
  session!.close()
  const otherHome = join(state.home, 'other-home'); mkdirSync(otherHome)
  session = new WorkspaceWriterSession(otherHome, () => {})
  session.select(first)
  expect(() => store.installWorkspaceSwitchProtection(session!)).toThrow()
  expect(readFileSync(registry, 'utf8')).toBe(before)
})
