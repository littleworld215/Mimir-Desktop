import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { readArchiveManifest } from '../../../electron/workspaceBackup/restoreArchive'
import { runSpaceBackup } from '../../../electron/workspaceBackup/backupService'

const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mimir-metadata-'))
  roots.push(home)
  const root = join(home, '科研'), destination = join(home, 'backup.zip'), stagingDir = join(home, 'stage')
  mkdirSync(join(root, '.mimir'), { recursive: true })
  return { root, destination, stagingDir, assetsDb: null }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('关闭后独立重开归档仍保留排除与外部依赖；摘要不含外部目标', async () => {
  const f = fixture(), external = 'Q:/not-opened/paper.pdf'
  const source = JSON.stringify({ 'library:papers': [{ pdfPath: external }], wiki: 'R:/free-text.md' })
  writeFileSync(join(f.root, '.mimir', 'store.json'), source)
  writeFileSync(join(f.root, 'large.dat'), Buffer.alloc(1025, 3))
  const result = await createBackup({ ...f, limits: { maxFileBytes: 1024, maxEntries: 100000, maxManifestBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 ** 4 } })
  const manifest = await readArchiveManifest(f.destination)
  expect(manifest).toMatchObject({ version: 1, metadata: {
    version: 1, database: { state: 'absent' }, maxFileBytes: 1024,
    excluded: [{ path: 'large.dat', size: 1025, reason: 'oversize', defaultDisposition: 'exclude' }],
    external: { coverage: 'known-structured-fields', unresolved: 0, references: [{ target: external, kind: 'pdf', status: 'not-included-unchecked' }] }
  } })
  expect(result).toMatchObject({ scope: { excludedCount: 1, externalCount: 1 } })
  expect(JSON.stringify(result)).not.toContain(external)
  expect(readFileSync(join(f.root, '.mimir', 'store.json'), 'utf8')).toBe(source)
})

it.each([0, 1, 2, 3, 4])('快照user_version实际为%i，不猜TARGET_VERSION', async version => {
  const f = fixture(), rel = '.mimir/assets/assets.db'
  mkdirSync(join(f.root, '.mimir', 'assets'))
  const db = new Database(join(f.root, rel))
  try {
    db.exec(`CREATE TABLE sample(value TEXT); PRAGMA user_version=${version}`)
    await createBackup({ ...f, assetsDb: db, assetsDbRelPath: rel })
    const manifest = await readArchiveManifest(f.destination)
    expect(manifest).toMatchObject({ metadata: { database: { state: 'present', path: rel, userVersion: version } } })
    expect(db.pragma('user_version', { simple: true })).toBe(version)
  } finally { db.close() }
})

it('清单整体预算包括metadata，超限不发布', async () => {
  const f = fixture()
  writeFileSync(join(f.root, '.mimir', 'store.json'), JSON.stringify({ 'library:papers': Array.from({ length: 5 }, (_, i) => ({ pdfPath: `Q:/${i}/${'a'.repeat(700)}.pdf` })) }))
  await expect(createBackup({ ...f, limits: { maxFileBytes: 10000, maxEntries: 100000, maxManifestBytes: 1500, maxTotalBytes: 1024 ** 4 } })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
})

it('生产服务传入来源版本并只返回范围摘要', async () => {
  const f = fixture(), home = join(f.root, '..')
  writeFileSync(join(f.root, '.mimir', 'store.json'), '{}')
  const result = await runSpaceBackup({ spaceId: 'synthetic' }, { home,
    resolveSpaces: () => [{ id: 'synthetic', name: 'Synthetic', path: f.root }],
    producer: { application: 'Mimir-Desktop', version: '0.0.3-test', platform: 'win32' }
  })
  expect(result).toMatchObject({ ok: true, scope: { producer: { version: '0.0.3-test' }, externalCount: 0 } })
})
