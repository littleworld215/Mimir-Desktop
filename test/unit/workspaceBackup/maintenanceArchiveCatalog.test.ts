import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { listRestoreArchives } from '../../../electron/workspaceBackup/restoreMain'
import { MaintenanceArchiveCatalog } from '../../../electron/workspaceBackup/maintenanceArchiveCatalog'
import { readArchiveScopeReceipt, verifyBackupWithScope } from '../../../electron/workspaceBackup/archiveScope'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mimir-scope-catalog-')); roots.push(home)
  const root = join(home, 'source'), archives = join(home, 'archives'), archive = join(archives, 'synthetic.zip')
  mkdirSync(join(root, '.mimir'), { recursive: true }); mkdirSync(archives)
  writeFileSync(join(root, '.mimir', 'store.json'), JSON.stringify({ 'library:papers': Array.from({ length: 101 }, (_, i) => ({ pdfPath: `Q:/external/${i}.pdf` })) }))
  await createBackup({ root, destination: archive, stagingDir: join(home, 'stage'), assetsDb: null })
  const candidates = await listRestoreArchives(archives), catalog = new MaintenanceArchiveCatalog()
  const [candidate] = catalog.replace(candidates)
  return { catalog, candidate, candidates, archive, archives }
}

it('只发主进程当前标识，分页不遗漏，默认摘要不含外部目标或内部票据', async () => {
  const f = await fixture(), id = f.candidate.archiveId!
  expect(id).toBeTypeOf('string')
  expect(f.candidate.scope).toMatchObject({ externalCount: 101 })
  expect(f.candidate).not.toHaveProperty('scopeReceipt')
  expect(JSON.stringify(f.candidate)).not.toContain('Q:/external')
  const first = await f.catalog.read({ archiveId: id }), last = await f.catalog.read({ archiveId: id, offset: 100 })
  expect(first.items).toHaveLength(100); expect(first.nextOffset).toBe(100)
  expect(last.items).toHaveLength(1); expect(last.nextOffset).toBeUndefined()
  expect(last.items[0]).toMatchObject({ kind: 'external', entry: { target: 'Q:/external/100.pdf' } })
})

it('匿名、额外路径及无效游标不读取任意文件', async () => {
  const f = await fixture(), archiveId = f.candidate.archiveId!
  for (const request of [null, {}, { archiveId, path: 'Q:/forged.zip' }, { archiveId, offset: null }, { archiveId, offset: -1 }, { archiveId, offset: 1.5 }, { archiveId, offset: 102 }]) {
    await expect(f.catalog.read(request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  }
  await expect(new MaintenanceArchiveCatalog().read({ archiveId })).rejects.toThrow()
})

it('概览刷新后旧标识失效，迟到读取也不能返回旧结果', async () => {
  const f = await fixture(), pending = f.catalog.read({ archiveId: f.candidate.archiveId! })
  const [next] = f.catalog.replace(f.candidates)
  await expect(pending).rejects.toThrow()
  await expect(f.catalog.read({ archiveId: f.candidate.archiveId! })).rejects.toThrow()
  expect((await f.catalog.read({ archiveId: next.archiveId! })).summary.externalCount).toBe(101)
})

it('列表读取后文件被替换，不能把旧摘要绑定到新stat', async () => {
  const f = await fixture()
  appendFileSync(f.archive, 'changed')
  const [again] = f.catalog.replace(f.candidates)
  await expect(f.catalog.read({ archiveId: again.archiveId! })).rejects.toThrow()
})
it('归档移动到替换后的同名父目录，旧标识仍失效', async () => {
  const f = await fixture()
  renameSync(f.archives, f.archives + '-old'); mkdirSync(f.archives)
  renameSync(join(f.archives + '-old', 'synthetic.zip'), f.archive)
  await expect(f.catalog.read({ archiveId: f.candidate.archiveId! })).rejects.toThrow()
})

it('坏包仍列出但不给说明标识，不伪装合法旧包', async () => {
  const f = await fixture(); writeFileSync(join(f.archives, 'broken.zip'), 'bad')
  const rows = f.catalog.replace(await listRestoreArchives(f.archives)), bad = rows.find(r => r.name === 'broken.zip')!
  expect(bad).toMatchObject({ scopeUnavailable: true })
  expect(bad.archiveId).toBeUndefined(); expect(bad.scope).toBeUndefined()
})

it('只读说明与内容校验分离，真正验包后才给passed', async () => {
  const f = await fixture(), receipt = await readArchiveScopeReceipt(f.archive)
  expect(receipt.scope.externalCount).toBe(101)
  expect(receipt).not.toHaveProperty('verification')
  expect(await verifyBackupWithScope(f.archive)).toMatchObject({ verification: 'passed', scope: { externalCount: 101 } })
})
