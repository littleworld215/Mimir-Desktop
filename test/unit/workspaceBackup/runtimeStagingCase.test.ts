import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildManifest, isExcludedFromBackup } from '../../../electron/workspaceBackup/manifest'
import { captureBackupSource, assertBackupSourceUnchanged } from '../../../electron/workspaceBackup/backupSource'

const { statRedirects } = vi.hoisted(() => ({ statRedirects: new Map<string, string>() }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync: ((...args: unknown[]) => Reflect.apply(actual.lstatSync, actual,
      [statRedirects.get(String(args[0])) ?? args[0], ...args.slice(1)])) as typeof actual.lstatSync
  }
})

const roots: Array<{ path: string; parent: string; owner: string }> = []
const staging = '.MIMIR/ASSETS/StAgInG'
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function fixture() {
  const parent = realpathSync(tmpdir()), path = mkdtempSync(join(parent, 'mimir-staging-case-')), owner = randomUUID()
  writeFileSync(join(path, 'test-owner'), owner, { flag: 'wx' })
  roots.push({ path, parent, owner })
  const root = join(path, 'space')
  const put = (name: string, text: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  put(staging + '/pending.bin', 'uncommitted synthetic body')
  put('.hidden', 'stable hidden data')
  put('project/staging/keep.bin', 'ordinary project data')
  put('.MIMIR/ASSETS/staging-copy/keep.bin', 'ordinary sibling data')
  if (process.platform === 'win32') {
    // Confirm this fixture really exercises a native case alias, rather than only a string match.
    expect(lstatSync(join(root, '.mimir/assets/staging'), { bigint: true }).ino)
      .toBe(lstatSync(join(root, staging), { bigint: true }).ino)
  }
  return { root, put }
}

afterEach(() => {
  statRedirects.clear()
  for (const entry of roots.splice(0)) {
    expect(dirname(realpathSync(entry.path))).toBe(entry.parent)
    expect(basename(entry.path).startsWith('mimir-staging-case-')).toBe(true)
    expect(lstatSync(entry.path).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(entry.path, 'test-owner'), 'utf8')).toBe(entry.owner)
    rmSync(entry.path, { recursive: true, force: true })
  }
})

it.each(['different', 'missing'])('Windows大小写不同且非同一目录时保留资料（身份控制：%s）', async condition => {
  const { root } = fixture()
  const control = join(root, 'case-distinct-control')
  if (condition === 'different') mkdirSync(control)
  // Only this control simulates case-distinct namespace metadata; positive fixtures use native lstat.
  statRedirects.set(join(root, '.mimir/assets/staging'), control)
  expect(isExcludedFromBackup(staging, root)).toBe(false)
  const result = await buildManifest(root)
  expect(result.entries.find(entry => entry.path === staging + '/pending.bin')).toMatchObject({ kind: 'file' })
})

it('受管staging目录的真实Windows大小写别名应排除，名称相近的普通资料保持', () => {
  const { root } = fixture()
  expect(isExcludedFromBackup(staging, root)).toBe(process.platform === 'win32')
  expect(isExcludedFromBackup(staging + '/pending.bin', root)).toBe(process.platform === 'win32')
  for (const path of ['project/staging/keep.bin', '.MIMIR/ASSETS/staging-copy/keep.bin', '.mimir/assets/staging.bak']) {
    expect(isExcludedFromBackup(path, root)).toBe(false)
  }
})

it('清单按实际受管目录排除未提交文件，稳定隐藏/项目资料及源字节保留', async () => {
  const { root } = fixture(), pending = join(root, staging, 'pending.bin'), before = digest(pending)
  const result = await buildManifest(root)
  expect(result.entries.some(entry => entry.path === staging || entry.path.startsWith(staging + '/')))
    .toBe(process.platform !== 'win32')
  for (const path of ['.hidden', 'project/staging/keep.bin', '.MIMIR/ASSETS/staging-copy/keep.bin']) {
    expect(result.entries.find(entry => entry.path === path)).toMatchObject({ kind: 'file', sha256: digest(join(root, path)) })
  }
  expect(result.excluded).toEqual([])
  expect(digest(pending)).toBe(before)
})

it('来源观察共享同一受管目录判定，不把Windows暂存内容变化当成稳定资料变化', async () => {
  const { root, put } = fixture()
  const before = await captureBackupSource(root)
  put(staging + '/pending.bin', 'changed uncommitted synthetic body')
  const after = await captureBackupSource(root)
  if (process.platform === 'win32') expect(() => assertBackupSourceUnchanged(before, after)).not.toThrow()
  else expect(() => assertBackupSourceUnchanged(before, after)).toThrow()
  expect(readFileSync(join(root, staging, 'pending.bin'), 'utf8')).toBe('changed uncommitted synthetic body')
})
