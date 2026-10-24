import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { remapSpaceStore } from '../../../electron/workspaceBackup/spaceStoreRemap'
import { createMaintenanceRestoreSteps } from '../../../electron/workspaceBackup/restoreMain'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { readArchiveManifest } from '../../../electron/workspaceBackup/restoreArchive'
import { parseArchiveManifest, DEFAULT_ARCHIVE_READ_LIMITS } from '../../../electron/workspaceBackup/archivePolicy'

const roots: string[] = []
const oldRoot = 'C:/old-space', newRoot = 'C:/new-space'
const opts = { separator: '/' as const, caseInsensitive: true }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const key = (dir: string) => createHash('sha1').update(dir).digest('hex').slice(0, 16)
function storeFixture() {
  return {
    'library:papers': { p: { pdfPath: `${oldRoot}/papers/p.pdf`, notes: oldRoot, metadata: { pdfPath: `${oldRoot}/unknown.pdf` } } },
    'library:projects': { x: { paperDir: `${oldRoot}/project`, title: oldRoot, metadata: { paperDir: oldRoot } } },
    'paper.recentProjects': [{ dir: `${oldRoot}/project`, name: oldRoot, lastOpened: 1 }],
    'chat:conversations': [{ id: 'c', title: oldRoot, messages: [{ content: oldRoot,
      artifacts: [{ path: `${oldRoot}/output/a.txt`, name: oldRoot }],
      run: { status: 'done', startedAt: 1, steps: [{ kind: 'tool', resultSummary: oldRoot, artifacts: [`${oldRoot}/output/a.txt`, 'C:/outside/a.txt'] }] },
      trace: { artifacts: [{ path: oldRoot }] }
    }] }],
    unknown: { paperDir: oldRoot, path: oldRoot, markdown: `\n${oldRoot}\n` }
  }
}

it.each(['project', 'recent', 'artifact', 'step'] as const)('改写精确结构字段%s，不改正文或未知同名字段', kind => {
  const before = storeFixture(), serialized = JSON.stringify(before)
  const { store } = remapSpaceStore(before, oldRoot, newRoot, opts)
  const typed = store as typeof before
  const value = kind === 'project' ? typed['library:projects'].x.paperDir : kind === 'recent' ? typed['paper.recentProjects'][0].dir
    : kind === 'artifact' ? typed['chat:conversations'][0].messages[0].artifacts[0].path : typed['chat:conversations'][0].messages[0].run.steps[0].artifacts[0]
  expect(value).toBe(`${newRoot}/${kind === 'project' || kind === 'recent' ? 'project' : 'output/a.txt'}`)
  expect(JSON.stringify(before)).toBe(serialized)
  expect(typed.unknown).toEqual(before.unknown)
  expect(typed['library:papers'].p.metadata).toEqual(before['library:papers'].p.metadata)
  expect(typed['chat:conversations'][0].messages[0].content).toBe(oldRoot)
  expect(typed['chat:conversations'][0].messages[0].run.steps[0].resultSummary).toBe(oldRoot)
  expect(typed['chat:conversations'][0].messages[0].trace).toEqual(before['chat:conversations'][0].messages[0].trace)
})

it.each(['C:/outside/project', 'C:/old-space-next/project', 'relative/project', 'https://example.invalid/project', ''])('外部/边界/相对值%j保留', value => {
  const before = { 'library:projects': { p: { paperDir: value } } }
  expect(remapSpaceStore(before, oldRoot, newRoot, opts).store).toEqual(before)
})

it('路径改写保留JSON原有__proto__业务键而不污染原型', () => {
  const before = JSON.parse('{"__proto__":{"research":"preserve"},"unknown":{"__proto__":{"n":1}}}') as Record<string, unknown>
  const { store } = remapSpaceStore(before, oldRoot, newRoot, opts)
  expect(Object.hasOwn(store, '__proto__')).toBe(true)
  expect(JSON.stringify(store)).toBe(JSON.stringify(before))
  expect(({} as { research?: string }).research).toBeUndefined()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-g04-'))
  roots.push(root)
  const stagingRoot = join(root, 'staging'), targetRoot = join(root, 'restored')
  mkdirSync(join(stagingRoot, '.mimir/paper-snapshots'), { recursive: true })
  const oldProject = `${oldRoot}/project`
  const original = { 'library:projects': { p: { paperDir: oldProject } }, 'assets-task-pack:source-id': { header: '合成科研模板', unknown: [1, 2] } }
  const storePath = join(stagingRoot, '.mimir/store.json')
  writeFileSync(storePath, JSON.stringify(original))
  const snapshots = join(stagingRoot, '.mimir/paper-snapshots')
  mkdirSync(join(snapshots, key(oldProject), 'snapshot-1'), { recursive: true })
  writeFileSync(join(snapshots, key(oldProject), 'snapshot-1/main.tex'), '原快照正文\n')
  const input = { archivePath: join(root, 'unused.zip'), stagingRoot, targetRoot, homeDir: root, spaceName: '恢复', oldRoot, sourceSpaceId: 'source-id' }
  const steps = createMaintenanceRestoreSteps(false, () => ({ release() {} }))
  const remap = () => Reflect.apply(steps.remap, steps, [input, stagingRoot, 'new-id']) as Promise<Record<string, unknown>>
  return { root, stagingRoot, targetRoot, storePath, snapshots, oldProject, input, remap }
}

it('快照桶按新目录重建键，旧模板保留且新UUID键可读取', async () => {
  const f = fixture(), original = JSON.parse(readFileSync(f.storePath, 'utf8'))
  await f.remap()
  const store = JSON.parse(readFileSync(f.storePath, 'utf8'))
  expect(store['assets-task-pack:new-id']).toEqual(original['assets-task-pack:source-id'])
  expect(store['assets-task-pack:source-id']).toEqual(original['assets-task-pack:source-id'])
  const project = store['library:projects'].p.paperDir
  expect(project).toContain(f.targetRoot)
  expect(readFileSync(join(f.snapshots, key(project), 'snapshot-1/main.tex'), 'utf8')).toBe('原快照正文\n')
})

it('未知快照桶保留并给出仅计数的提示', async () => {
  const f = fixture()
  mkdirSync(join(f.snapshots, 'unknown-bucket'))
  writeFileSync(join(f.snapshots, 'unknown-bucket/a.txt'), '未知资料')
  const report = await f.remap()
  expect(report).toMatchObject({ associations: { unknownSnapshotBuckets: 1 } })
  expect(readFileSync(join(f.snapshots, 'unknown-bucket/a.txt'), 'utf8')).toBe('未知资料')
})

it('快照目标桶冲突阻断，不合并或覆盖', async () => {
  const f = fixture()
  const destination = join(f.snapshots, key(join(f.targetRoot, 'project')))
  mkdirSync(destination)
  writeFileSync(join(destination, 'personal.txt'), '保留')
  const before = readFileSync(f.storePath)
  await expect(f.remap()).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(f.storePath)).toEqual(before)
  expect(readFileSync(join(destination, 'personal.txt'), 'utf8')).toBe('保留')
  expect(existsSync(join(f.snapshots, key(f.oldProject)))).toBe(true)
})

it('新UUID模板键冲突阻断且原JSON不变', async () => {
  const f = fixture()
  const store = JSON.parse(readFileSync(f.storePath, 'utf8'))
  store['assets-task-pack:new-id'] = { header: '另一个模板' }
  writeFileSync(f.storePath, JSON.stringify(store))
  const before = readFileSync(f.storePath)
  await expect(f.remap()).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(f.storePath)).toEqual(before)
})

it.skipIf(process.platform !== 'win32')('Windows原快照桶仅大小写不同仍重新关联', async () => {
  const f = fixture()
  renameSync(join(f.snapshots, key(f.oldProject)), join(f.snapshots, key(f.oldProject).toUpperCase()))
  await f.remap()
  const store = JSON.parse(readFileSync(f.storePath, 'utf8'))
  expect(readFileSync(join(f.snapshots, key(store['library:projects'].p.paperDir), 'snapshot-1/main.tex'), 'utf8')).toBe('原快照正文\n')
})

it('暂存控制父目录为junction时拒绝，不写到链接指向目录', async () => {
  const f = fixture(), external = join(f.root, 'external-mimir')
  renameSync(join(f.stagingRoot, '.mimir'), external)
  symlinkSync(external, join(f.stagingRoot, '.mimir'), 'junction')
  const before = readFileSync(join(external, 'store.json'))
  await expect(f.remap()).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(join(external, 'store.json'))).toEqual(before)
  expect(existsSync(join(external, 'paper-snapshots', key(f.oldProject)))).toBe(true)
})

it('有明确来源ID时不猜选其它模板，未关联模板保留并计数', async () => {
  const f = fixture()
  f.input.sourceSpaceId = 'no-template-for-this-id'
  const report = await f.remap()
  expect(report).toMatchObject({ associations: { templatesRelinked: 0, unresolvedTemplates: 1 } })
  const store = JSON.parse(readFileSync(f.storePath, 'utf8'))
  expect(Object.hasOwn(store, 'assets-task-pack:new-id')).toBe(false)
  expect(store['assets-task-pack:source-id']).toEqual({ header: '合成科研模板', unknown: [1, 2] })
})

it('外部项目快照单独计数保留，不冒充未知来源也不搬外部项目', async () => {
  const f = fixture(), external = 'D:/external-project'
  const store = JSON.parse(readFileSync(f.storePath, 'utf8'))
  store['library:projects'].external = { paperDir: external }
  writeFileSync(f.storePath, JSON.stringify(store))
  mkdirSync(join(f.snapshots, key(external)))
  writeFileSync(join(f.snapshots, key(external), 'preserved.txt'), '外部项目的已存快照')
  const report = await f.remap()
  expect(report).toMatchObject({ associations: { externalSnapshotBuckets: 1, unknownSnapshotBuckets: 0 } })
  expect(JSON.parse(readFileSync(f.storePath, 'utf8'))['library:projects'].external.paperDir).toBe(external)
  expect(readFileSync(join(f.snapshots, key(external), 'preserved.txt'), 'utf8')).toBe('外部项目的已存快照')
})

it('旧包无来源ID时仅唯一模板兼容；多模板不得猜选', async () => {
  const f = fixture()
  Reflect.deleteProperty(f.input, 'sourceSpaceId')
  await f.remap()
  const store = JSON.parse(readFileSync(f.storePath, 'utf8'))
  expect(store['assets-task-pack:new-id']).toEqual(store['assets-task-pack:source-id'])
})

it('无来源ID且多旧模板键时拒绝，不合并、不改JSON', async () => {
  const f = fixture()
  Reflect.deleteProperty(f.input, 'sourceSpaceId')
  const store = JSON.parse(readFileSync(f.storePath, 'utf8'))
  store['assets-task-pack:another-id'] = { header: '另一空间' }
  writeFileSync(f.storePath, JSON.stringify(store))
  const before = readFileSync(f.storePath)
  await expect(f.remap()).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
  expect(readFileSync(f.storePath)).toEqual(before)
})

it('备份清单记录显式来源空间ID，格式1不变', async () => {
  const f = fixture(), root = join(f.root, 'source')
  mkdirSync(root)
  writeFileSync(join(root, 'a.txt'), '合成')
  const options = { root, destination: join(f.root, 'backup.zip'), stagingDir: join(f.root, 'packing'), assetsDb: null, sourceSpaceId: 'source-id' }
  await createBackup(options)
  const manifest = await readArchiveManifest(options.destination)
  expect(manifest).toMatchObject({ version: 1, sourceSpaceId: 'source-id' })
})

it.each([null, {}, '', 'bad\0id'])('来源空间ID元数据%j非法时拒绝', sourceSpaceId => {
  const content = Buffer.from(JSON.stringify({ version: 1, generatedAt: '2026-10-24', sourceSpaceId, entries: [] }))
  expect(() => parseArchiveManifest(content, DEFAULT_ARCHIVE_READ_LIMITS)).toThrowError(expect.objectContaining({ code: 'MANIFEST_INVALID' }))
})
