import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { readArchiveManifest } from '../../../electron/workspaceBackup/restoreArchive'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
async function pack(store?: string, sparse = false) {
  const home = fs.mkdtempSync(join(tmpdir(), 'mimir-metasource-')); roots.push(home)
  const root = join(home, 'space'), destination = join(home, 'backup.zip')
  fs.mkdirSync(join(root, '.mimir'), { recursive: true })
  if (store !== undefined) fs.writeFileSync(join(root, '.mimir', 'store.json'), store)
  if (sparse) {
    const fd = fs.openSync(join(root, '.mimir', 'store.json'), 'w')
    try { fs.ftruncateSync(fd, 65 * 1024 * 1024) } finally { fs.closeSync(fd) }
  }
  await createBackup({ root, destination, stagingDir: join(home, 'staging'), assetsDb: null,
    ...(sparse ? { limits: { maxFileBytes: 1024, maxManifestBytes: 64 * 1024 * 1024, maxEntries: 100000, maxTotalBytes: 1024 ** 4 } } : {}) })
  return (await readArchiveManifest(destination)).metadata
}

it.each([
  [undefined, 'missing-store'], ['{bad', 'invalid-store'], ['[]', 'invalid-store'],
  [JSON.stringify({ 'library:papers': [{ pdfPath: 'relative.pdf' }] }), 'ambiguous-reference'],
  [JSON.stringify({ 'library:papers': [{ pdfPath: 12 }] }), 'ambiguous-reference']
])('无法可靠识别%s时不声称无依赖', async (store, reason) => {
  expect(await pack(store)).toMatchObject({ external: { coverage: 'unknown', reason } })
})

it('65MiB空间JSON预检后标未知；不整块读取或改写源', async () => {
  expect(await pack(undefined, true)).toMatchObject({ external: { coverage: 'unknown', reason: 'oversize-store' } })
})

it('五类结构引用记录在包内，自由正文不扫描且外部目标不打开', async () => {
  const outside = 'Q:/MIMIR-SYNTHETIC-UNREADABLE/'
  const open = vi.spyOn(fs, 'openSync'), stat = vi.spyOn(fs, 'statSync')
  const value = await pack(JSON.stringify({
    'library:papers': { a: { pdfPath: `${outside}a.pdf` } },
    'library:projects': [{ paperDir: `${outside}b` }],
    'paper.recentProjects': [{ dir: `${outside}c` }],
    'chat:conversations': [{ messages: [{ content: `${outside}body`, artifacts: [{ path: `${outside}d` }], run: { steps: [{ artifacts: [`${outside}e`] }] } }] }],
    wiki: `${outside}wiki`
  }))
  expect(value?.external).toMatchObject({ coverage: 'known-structured-fields', unresolved: 0 })
  expect(value?.external.references.map(r => r.target)).toEqual([`${outside}a.pdf`, `${outside}b`, `${outside}c`, `${outside}d`, `${outside}e`])
  expect(open.mock.calls.some(c => String(c[0]).startsWith(outside))).toBe(false)
  expect(stat.mock.calls.some(c => String(c[0]).startsWith(outside))).toBe(false)
})
