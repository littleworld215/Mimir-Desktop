import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { runMaintenanceRestore } from '../../../electron/workspaceBackup/restoreMain'
import { appendWorkspaceRecord, buildRegistryAppendInput } from '../../../electron/workspaceBackup/registryAppend'
import { readArchiveManifest } from '../../../electron/workspaceBackup/restoreArchive'
import { acquireStagingLock } from '../../../electron/workspaceBackup/maintenanceRestoreHandler'

const roots: string[] = []
const leases: Array<{ release(): void }> = []
const owner = 'v15-target-safety'
afterEach(() => {
  for (const lease of leases.splice(0)) lease.release()
  for (const root of roots.splice(0)) {
    expect(root.startsWith(join(tmpdir(), 'mimir-target-safety-'))).toBe(true)
    expect(lstatSync(root).isSymbolicLink()).toBe(false)
    expect(realpathSync(root).toLowerCase()).toBe(root.toLowerCase())
    expect(readFileSync(join(root, '.test-owner'), 'utf8')).toBe(owner)
    rmSync(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-target-safety-')); roots.push(root)
  writeFileSync(join(root, '.test-owner'), owner)
  const home = join(root, 'home'), source = join(root, 'source'), registered = join(root, 'registered')
  for (const place of [home, source, registered]) mkdirSync(join(place, '.mimir'), { recursive: true })
  writeFileSync(join(source, '.mimir/store.json'), JSON.stringify({ unknown: 'synthetic source' }))
  writeFileSync(join(source, 'original.txt'), 'original\n')
  const registryFile = join(home, '.mimir/store.json')
  const writeRegistry = (path: string) => writeFileSync(registryFile, JSON.stringify({ 'workspaces:list': [{ id: 'original', name: '原空间', path }], activeWorkspaceId: 'original', unknown: [1, 2] }))
  writeRegistry(registered)
  const archive = join(root, 'archive.zip')
  await createBackup({ root: source, destination: archive, stagingDir: join(root, 'packing'), assetsDb: null })
  const lock = (path: string) => { const lease = acquireStagingLock(path); leases.push(lease); return lease }
  return { root, home, source, registered, registryFile, archive, writeRegistry, lock }
}
for (const scenario of ['source-child', 'registered-child', 'source-dot-child', 'registered-case-child', 'control-child'] as const) {
  it(`重叠目标 ${scenario} 在创建操作记录或暂存前拒绝，源与注册表不变`, async () => {
    const f = await fixture(), before = readFileSync(f.registryFile)
    let parent = scenario === 'control-child' ? join(f.home, '.mimir') : scenario.startsWith('source') ? f.source : f.registered
    if (scenario === 'registered-case-child' && process.platform === 'win32') parent = parent.toUpperCase()
    const targetRoot = scenario === 'source-dot-child' ? `${f.source}/../source/nested` : join(parent, 'nested')
    const beginOperation = vi.fn(() => { throw Error('Must reject before journal') })
    const result = await runMaintenanceRestore({ archivePath: f.archive, targetRoot, spaceName: '合成恢复' }, {
      homeDir: f.home, session: { assertUsable() {} }, lockStagingRoot: f.lock, beginOperation
    })
    expect(result.failure?.code).toBe('INVALID_TARGET')
    expect(beginOperation).not.toHaveBeenCalled()
    expect(existsSync(targetRoot)).toBe(false)
    expect(readFileSync(f.registryFile)).toEqual(before)
    expect(readFileSync(join(f.source, 'original.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(join(f.home, '.mimir/restore-operations'))).toBe(false)
  })
}
for (const direction of ['descendant', 'ancestor'] as const) {
  it(`追加登记拒绝已有空间的${direction}，先于保护快照且原注册表字节不变`, async () => {
    const f = await fixture()
    const path = direction === 'descendant' ? join(f.registered, 'nested') : f.root
    const before = readFileSync(f.registryFile)
    expect(() => appendWorkspaceRecord(f.home, buildRegistryAppendInput({ id: 'new-space', name: '新空间', path })))
      .toThrowError(expect.objectContaining({ code: 'REGISTRY_INVALID' }))
    expect(readFileSync(f.registryFile)).toEqual(before)
    expect(existsSync(join(f.home, '.mimir/restore-registry-snapshots'))).toBe(false)
  })
}
it('相同字符串前缀的兄弟路径可恢复，旧包缺少sourceRoot仍核对当前登记根', async () => {
  const f = await fixture(), targetRoot = f.source + '-restored'
  const manifest = await readArchiveManifest(f.archive)
  const result = await runMaintenanceRestore({ archivePath: f.archive, targetRoot, spaceName: '兄弟空间' }, {
    homeDir: f.home, session: { assertUsable() {} }, lockStagingRoot: f.lock,
    readManifest: async () => ({ ...manifest, sourceRoot: undefined })
  })
  expect(result.stage).toBe('done')
  expect(JSON.parse(readFileSync(f.registryFile, 'utf8'))['workspaces:list']).toHaveLength(2)
  expect(readFileSync(join(targetRoot, 'original.txt'), 'utf8')).toBe('original\n')
})
it('可信源根存在时，同字符串前缀的兄弟路径仍可恢复', async () => {
  const f = await fixture(), targetRoot = f.source + '-restored'
  const result = await runMaintenanceRestore({ archivePath: f.archive, targetRoot, spaceName: '兄弟空间' }, {
    homeDir: f.home, session: { assertUsable() {} }, lockStagingRoot: f.lock
  })
  expect(result.stage).toBe('done')
  expect(readFileSync(join(targetRoot, 'original.txt'), 'utf8')).toBe('original\n')
})
it('旧包缺少源根也不能在已登记空间内恢复，尚未创建操作记录', async () => {
  const f = await fixture(), targetRoot = join(f.registered, 'nested'), manifest = await readArchiveManifest(f.archive)
  const beginOperation = vi.fn(() => { throw Error('Must reject before journal') })
  const result = await runMaintenanceRestore({ archivePath: f.archive, targetRoot, spaceName: '旧包' }, {
    homeDir: f.home, session: { assertUsable() {} }, lockStagingRoot: f.lock, beginOperation,
    readManifest: async () => ({ ...manifest, sourceRoot: undefined })
  })
  expect(result.failure?.code).toBe('INVALID_TARGET')
  expect(beginOperation).not.toHaveBeenCalled()
  expect(existsSync(targetRoot)).toBe(false)
})
it('校验后登记根变成目标祖先时，发布前重新读取并拒绝，不追加登记', async () => {
  const f = await fixture(), targetRoot = join(f.root, 'restored')
  let changedRegistry: Buffer | undefined
  const result = await runMaintenanceRestore({ archivePath: f.archive, targetRoot, spaceName: '迟到冲突' }, {
    homeDir: f.home, session: { assertUsable() {} }, lockStagingRoot: f.lock,
    adapter: { prepareAssets: async () => { f.writeRegistry(f.root); changedRegistry = readFileSync(f.registryFile) } }
  })
  expect(changedRegistry).toBeDefined()
  expect(result.failure?.code).toBe('INVALID_TARGET')
  expect(existsSync(targetRoot)).toBe(false)
  expect(readFileSync(f.registryFile)).toEqual(changedRegistry)
  expect(existsSync(join(f.home, '.mimir/restore-registry-snapshots'))).toBe(false)
})
it('已登记目录无法判为绝对路径时，预检保守拒绝并保留登记原文', async () => {
  const f = await fixture(); f.writeRegistry('relative-old-root')
  const before = readFileSync(f.registryFile), beginOperation = vi.fn(() => { throw Error('Must reject before journal') })
  const result = await runMaintenanceRestore({ archivePath: f.archive, targetRoot: join(f.root, 'new'), spaceName: '合成恢复' }, {
    homeDir: f.home, session: { assertUsable() {} }, lockStagingRoot: f.lock, beginOperation
  })
  expect(result.failure?.code).toBe('INVALID_TARGET')
  expect(beginOperation).not.toHaveBeenCalled()
  expect(readFileSync(f.registryFile)).toEqual(before)
})
for (const kind of ['registered-parent-alias', 'source-alias'] as const) {
  it(`真实目录别名 ${kind} 不能绕过实体路径的嵌套拒绝`, async () => {
    const f = await fixture(), alias = join(f.root, 'alias')
    let targetRoot: string
    let readManifest: (() => Promise<Awaited<ReturnType<typeof readArchiveManifest>>>) | undefined
    if (kind === 'registered-parent-alias') {
      const physical = join(f.root, 'physical'), original = join(physical, 'registered')
      mkdirSync(join(original, '.mimir'), { recursive: true })
      symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
      expect(realpathSync(alias)).toBe(realpathSync(physical))
      f.writeRegistry(join(alias, 'registered'))
      targetRoot = join(original, 'nested')
    } else {
      symlinkSync(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir')
      expect(realpathSync(alias)).toBe(realpathSync(f.source))
      const manifest = await readArchiveManifest(f.archive)
      readManifest = async () => ({ ...manifest, sourceRoot: alias })
      targetRoot = join(f.source, 'nested')
    }
    const before = readFileSync(f.registryFile), beginOperation = vi.fn(() => { throw Error('Must reject before journal') })
    const result = await runMaintenanceRestore({ archivePath: f.archive, targetRoot, spaceName: '别名反例' }, {
      homeDir: f.home, session: { assertUsable() {} }, lockStagingRoot: f.lock, beginOperation, ...(readManifest ? { readManifest } : {})
    })
    expect(result.failure?.code).toBe('INVALID_TARGET')
    expect(beginOperation).not.toHaveBeenCalled()
    expect(existsSync(targetRoot)).toBe(false)
    expect(readFileSync(f.registryFile)).toEqual(before)
  })
}
