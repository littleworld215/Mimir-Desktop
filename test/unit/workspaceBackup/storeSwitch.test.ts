import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { WorkspaceWriterSession } from '../../../electron/workspaceBackup/writerSession'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'

const state = vi.hoisted(() => ({ home: '', elapsed: 0, failRename: false, failUnlink: false, failOldUnlink: false, failCopy: false, failReadDir: false, slowTemp: false, slowRead: false, checkWrites: false, copies: [] as string[] }))
// 只在指定IO边界推进单调时钟，避免10ms预算先被无关磁盘调度耗尽。
vi.mock('node:perf_hooks', async original => {
  const actual = await original<typeof import('node:perf_hooks')>()
  return { ...actual, performance: { now: () => actual.performance.now() + state.elapsed } }
})
vi.mock('os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }))
vi.mock('electron', () => ({ app: { getPath: () => join(state.home, 'profile') } }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, writeFileSync: (path: string | number, ...args: any[]) => {
    if (state.checkWrites && typeof path === 'string' && path.includes('.tmp-store.json-')) {
      const global = dirname(path) === join(state.home, '.mimir')
      if (!fs.existsSync(join(dirname(path), global ? 'registry.writer-lock' : 'workspace.writer-lock'))) throw Error('TEMP_WRITE_BEFORE_LOCK')
    }
    if (state.slowTemp && typeof path === 'string' && path.includes('.tmp-store.json-')) {
      state.slowTemp = false
      state.elapsed += 6000
    }
    ;(fs.writeFileSync as any)(path, ...args)
  }, readFileSync: (path: string, ...args: any[]) => {
    if (state.slowRead && path === join(state.home, 'b/.mimir/store.json')) {
      state.slowRead = false
      state.elapsed += 6000
    }
    return (fs.readFileSync as any)(path, ...args)
  }, readdirSync: (path: string, ...args: any[]) => {
    if (state.failReadDir && path === join(state.home, 'profile/projects')) throw Error('synthetic directory read failure')
    return (fs.readdirSync as any)(path, ...args)
  }, cpSync: (src: string, dest: string, opts: import('node:fs').CopySyncOptions) => {
    state.copies.push(`${src} -> ${dest}`)
    if (state.checkWrites && !fs.existsSync(join(dirname(dest), '.mimir/workspace.writer-lock'))) throw Error('COPY_BEFORE_LOCK')
    if (state.failCopy) throw Error('synthetic copy failure')
    fs.cpSync(src, dest, opts)
  }, renameSync: (a: string, b: string) => {
    if (state.checkWrites && b.endsWith(join('.mimir', 'store.json'))) {
      const global = b === join(state.home, '.mimir/store.json')
      const lock = join(dirname(b), global ? 'registry.writer-lock' : 'workspace.writer-lock')
      if (!fs.existsSync(lock)) throw Error('BUSINESS_WRITE_BEFORE_LOCK')
    }
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
  state.elapsed = 0
  state.failRename = false; state.failUnlink = false; state.failOldUnlink = false
  state.checkWrites = false
  state.failCopy = false
  state.failReadDir = false
  state.slowTemp = false; state.slowRead = false
  state.copies = []
  session?.close(); session = undefined
  if (state.home.startsWith(join(tmpdir(), 'mimir-real-store-switch-'))) rmSync(state.home, { recursive: true, force: true })
})
async function preparedFixture() {
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
  return { store, first, second, registry: join(state.home, '.mimir/store.json') }
}
async function fixture(install = true) {
  const result = await preparedFixture()
  const { store, first } = result
  store.loadStore()
  session = new WorkspaceWriterSession(state.home, () => {})
  session.select(first)
  if (install) store.installWorkspaceSwitchProtection(session)
  return result
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
it('受保护已有空间初始化在第一笔业务写入前占注册表及空间锁', async () => {
  const { store, first } = await preparedFixture()
  session = new WorkspaceWriterSession(state.home, () => {})
  state.checkWrites = true
  store.loadStore(session)
  expect(existsSync(join(first, '.mimir/workspace.writer-lock'))).toBe(true)
  expect(store.getStoreValue('custom')).toBe('first')
  store.setStoreValue('custom', 'saved')
  expect(JSON.parse(readFileSync(join(first, '.mimir/store.json'), 'utf8')).custom).toBe('saved')
})
it('已有空间残留锁阻断初始化，注册表逐字不变，不降级为可写会话', async () => {
  const { store, first, registry } = await preparedFixture()
  writeFileSync(join(first, '.mimir/workspace.writer-lock'), 'another writer')
  const before = readFileSync(registry, 'utf8')
  session = new WorkspaceWriterSession(state.home, () => {})
  expect(() => store.loadStore(session)).toThrow()
  expect(readFileSync(registry, 'utf8')).toBe(before)
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
})
it('首次启动仍无注册空间，但草稿兜底目录先占锁再保存', async () => {
  const { store, registry } = await preparedFixture()
  writeFileSync(registry, '{"settings":{"keep":"synthetic"}}')
  session = new WorkspaceWriterSession(state.home, () => {})
  state.checkWrites = true
  store.loadStore(session)
  expect(store.getActiveWorkspace()).toBeNull()
  expect(store.listWorkspaces()).toHaveLength(0)
  expect(existsSync(join(store.spaceRoot(), '.mimir/workspace.writer-lock'))).toBe(true)
  store.setStoreValue('draft', 'first')
  expect(JSON.parse(readFileSync(join(store.spaceRoot(), '.mimir/store.json'), 'utf8')).draft).toBe('first')
})
it('旧业务键和项目目录迁入已占锁的新空间，旧全局凭据保持', async () => {
  const { store, registry } = await preparedFixture()
  writeFileSync(registry, JSON.stringify({ settings: { keep: 'synthetic' }, 'library:papers': [{ id: 'legacy' }] }))
  mkdirSync(join(state.home, 'profile/projects'), { recursive: true })
  writeFileSync(join(state.home, 'profile/projects/sample.txt'), 'original project')
  const electron = await import('electron')
  expect(electron.app.getPath('userData')).toBe(join(state.home, 'profile'))
  session = new WorkspaceWriterSession(state.home, () => {})
  state.checkWrites = true
  store.loadStore(session)
  expect(store.getStoreValue('library:papers')).toEqual([{ id: 'legacy' }])
  expect(store.getStoreValue('settings')).toEqual({ keep: 'synthetic' })
  expect(existsSync(join(store.spaceRoot(), '.mimir/workspace.writer-lock'))).toBe(true)
  expect(state.copies).toHaveLength(1)
  expect(readFileSync(join(state.home, 'profile/projects/sample.txt'), 'utf8')).toBe('original project')
  expect(readFileSync(join(store.spaceRoot(), 'projects/sample.txt'), 'utf8')).toBe('original project')
})
it('受保护初始化拒绝错误HOME且不改原始注册表', async () => {
  const { store, registry } = await preparedFixture()
  const before = readFileSync(registry, 'utf8')
  const other = join(state.home, 'other'); mkdirSync(other)
  session = new WorkspaceWriterSession(other, () => {})
  expect(() => store.loadStore(session)).toThrow('对应写锁')
  expect(readFileSync(registry, 'utf8')).toBe(before)
})
it('受保护初始化遇到损坏全局JSON不改原文，后续写入阻断', async () => {
  const { store, registry } = await preparedFixture()
  writeFileSync(registry, '{broken')
  session = new WorkspaceWriterSession(state.home, () => {})
  expect(() => store.loadStore(session)).toThrow('损坏')
  expect(readFileSync(registry, 'utf8')).toBe('{broken')
  expect(() => store.setStoreValue('settings', {})).toThrow()
})
it('初始化指针保存失败释放新锁，保留注册表并阻断会话', async () => {
  const { store, registry, first } = await preparedFixture()
  const before = readFileSync(registry, 'utf8')
  session = new WorkspaceWriterSession(state.home, () => {})
  state.failRename = true
  expect(() => store.loadStore(session)).toThrow('pointer write failure')
  expect(readFileSync(registry, 'utf8')).toBe(before)
  expect(existsSync(join(first, '.mimir/workspace.writer-lock'))).toBe(false)
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
})
it('旧项目复制失败保留原项目及注册表，不能注册部分迁移空间', async () => {
  const { store, registry } = await preparedFixture()
  const before = JSON.stringify({ settings: {}, 'library:papers': [{ id: 'legacy' }] })
  writeFileSync(registry, before)
  mkdirSync(join(state.home, 'profile/projects'), { recursive: true })
  const original = join(state.home, 'profile/projects/sample.txt')
  writeFileSync(original, 'original project')
  session = new WorkspaceWriterSession(state.home, () => {})
  state.failCopy = true
  expect(() => store.loadStore(session)).toThrow('copy failure')
  expect(readFileSync(registry, 'utf8')).toBe(before)
  expect(readFileSync(original, 'utf8')).toBe('original project')
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
})
it('普通装载后不能迟到启用受保护初始化', async () => {
  const { store } = await fixture(false)
  expect(() => store.loadStore(session)).toThrow('首次装载前')
})
it('受保护初始化遇到损坏空间JSON必须阻断，全局和管理也不能继续写', async () => {
  const { store, registry, first } = await preparedFixture()
  const file = join(first, '.mimir/store.json')
  writeFileSync(file, '{broken-space')
  session = new WorkspaceWriterSession(state.home, () => {})
  expect(() => store.loadStore(session)).toThrow('损坏')
  expect(readFileSync(file, 'utf8')).toBe('{broken-space')
  const snapshot = readFileSync(registry, 'utf8')
  expect(() => store.setStoreValue('settings', {})).toThrow()
  expect(() => store.renameWorkspace('a', 'changed')).toThrow()
  expect(readFileSync(registry, 'utf8')).toBe(snapshot)
})
it('旧项目目录读取失败不能当空目录跳过并注册新空间', async () => {
  const { store, registry } = await preparedFixture()
  const before = JSON.stringify({ settings: {}, 'library:papers': [{ id: 'legacy' }] })
  writeFileSync(registry, before)
  mkdirSync(join(state.home, 'profile/projects'), { recursive: true })
  session = new WorkspaceWriterSession(state.home, () => {})
  state.failReadDir = true
  expect(() => store.loadStore(session)).toThrow('directory read failure')
  expect(readFileSync(registry, 'utf8')).toBe(before)
  expect(() => store.setStoreValue('settings', {})).toThrow()
})
it('仅有旧目录时探测读取失败也必须阻断，不能误判为全新安装', async () => {
  const { store, registry } = await preparedFixture()
  const before = '{"settings":{}}'
  writeFileSync(registry, before)
  mkdirSync(join(state.home, 'profile/projects'), { recursive: true })
  session = new WorkspaceWriterSession(state.home, () => {})
  state.failReadDir = true
  expect(() => store.loadStore(session)).toThrow('directory read failure')
  expect(readFileSync(registry, 'utf8')).toBe(before)
  expect(() => store.setStoreValue('draft', 'unsafe')).toThrow()
})
it('任务保护安装后裸写入及任务内直接切空间均在改内存前拒绝', async () => {
  const { store, registry } = await fixture()
  const gate = new WorkspaceOperationGate()
  store.installWorkspaceOperationProtection(gate)
  const bytes = readFileSync(registry, 'utf8')
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
  expect(() => store.switchWorkspace('b')).toThrow()
  await gate.run(store.captureWorkspaceOperation(), async () => {
    expect(() => store.switchWorkspace('b')).toThrow()
    store.setStoreValue('custom', 'safe')
  })
  expect(store.getStoreValue('custom')).toBe('safe')
  expect(readFileSync(registry, 'utf8')).toBe(bytes)
})
it('旧任务先按固定根保存再串行切空间，新空间不混入旧写入', async () => {
  const { store, first, second } = await fixture()
  const gate = new WorkspaceOperationGate()
  store.installWorkspaceOperationProtection(gate)
  let finish!: () => void
  const scope = store.captureWorkspaceOperation()
  const task = gate.run(scope, async () => {
    await new Promise<void>(resolve => { finish = resolve })
    expect(store.spaceRoot()).toBe(first)
    store.setStoreValue('custom', 'old task saved')
  })
  const control = gate.runControl(1000, async () => { store.switchWorkspace('b') })
  finish(); await task; await control
  expect(store.spaceRoot()).toBe(second)
  expect(readFileSync(join(first, '.mimir/store.json'), 'utf8')).toContain('old task saved')
  expect(store.getStoreValue('custom')).toBe('second')
  expect(store.captureWorkspaceOperation().root).toBe(second)
})
it('错误任务ID/代际/根及结束后的回调不能读取正文或写入任何层', async () => {
  const { store, registry } = await fixture()
  const gate = new WorkspaceOperationGate()
  store.installWorkspaceOperationProtection(gate)
  const scope = store.captureWorkspaceOperation(), bytes = readFileSync(registry, 'utf8')
  for (const incorrect of [{ ...scope, id: 'bad' }, { ...scope, epoch: 'bad' }, { ...scope, root: 'bad' }]) {
    await gate.run(incorrect, async () => {
      expect(() => store.spaceRoot()).toThrow()
      expect(() => store.getStoreValue('custom')).toThrow()
      expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
      expect(() => store.setStoreValue('settings', {})).toThrow()
    })
  }
  let late!: () => void
  await gate.run(scope, async () => { late = gate.bind(() => store.setStoreValue('custom', 'late')) })
  expect(() => late()).toThrow()
  expect(store.getStoreValue('custom')).toBe('first')
  expect(readFileSync(registry, 'utf8')).toBe(bytes)
})
it('控制失败后的裸写/注册管理持续阻断，任务保护不能被替换', async () => {
  const { store, registry } = await fixture()
  const gate = new WorkspaceOperationGate()
  store.installWorkspaceOperationProtection(gate)
  expect(() => store.installWorkspaceOperationProtection(new WorkspaceOperationGate())).toThrow()
  const bytes = readFileSync(registry, 'utf8')
  await expect(gate.runControl(1000, async () => { throw Error('failed shutdown') })).rejects.toThrow()
  expect(() => store.setStoreValue('settings', {})).toThrow()
  expect(() => store.renameWorkspace('a', 'changed')).toThrow()
  expect(readFileSync(registry, 'utf8')).toBe(bytes)
})
it('控制内同步临时文件写入耗尽预算后不能rename发布指针', async () => {
  const { store, registry, first, second } = await fixture()
  const gate = new WorkspaceOperationGate()
  store.installWorkspaceOperationProtection(gate)
  const before = readFileSync(registry, 'utf8')
  state.slowTemp = true
  await expect(gate.runControl(5000, async () => { store.switchWorkspace('b') })).rejects.toThrow('超时')
  expect(readFileSync(registry, 'utf8')).toBe(before)
  expect(store.getActiveWorkspace()?.id).toBe('a')
  expect(existsSync(join(first, '.mimir/workspace.writer-lock'))).toBe(true)
  expect(existsSync(join(second, '.mimir/workspace.writer-lock'))).toBe(false)
})
it('指针已发布而同步读新缓存耗尽预算时保持两锁并阻断，不假装回滚指针', async () => {
  const { store, registry, first, second } = await fixture()
  const gate = new WorkspaceOperationGate()
  store.installWorkspaceOperationProtection(gate)
  state.slowRead = true
  await expect(gate.runControl(5000, async () => { store.switchWorkspace('b') })).rejects.toThrow('超时')
  expect(JSON.parse(readFileSync(registry, 'utf8')).activeWorkspaceId).toBe('b')
  expect(existsSync(join(first, '.mimir/workspace.writer-lock'))).toBe(true)
  expect(existsSync(join(second, '.mimir/workspace.writer-lock'))).toBe(true)
  expect(() => store.setStoreValue('custom', 'unsafe')).toThrow()
})
