import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanRegistrySnapshotProtection } from '../../../electron/workspaceBackup/doctorRegistrySnapshots'
import { appendWorkspaceRecord } from '../../../electron/workspaceBackup/registryAppend'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mimir-doctor-private-')); roots.push(home)
  mkdirSync(join(home, '.mimir'))
  return home
}
it('没有快照时只读检查不创建私有目录', () => {
  const home = fixture()
  const report = scanRegistrySnapshotProtection(home)
  expect(report).toMatchObject({ id: 'REGISTRY_SNAPSHOT_PROTECTION', severity: 'ok', facts: { verified: 0 } })
  expect(readdirSync(join(home, '.mimir'))).toEqual([])
})
it('历史平铺快照保护未知，原字节不动，不自动迁移', () => {
  const home = fixture(), old = join(home, '.mimir', 'store.json.pre-restore-old.bak')
  writeFileSync(old, 'SYNTHETIC-CREDENTIAL')
  expect(scanRegistrySnapshotProtection(home)).toMatchObject({ severity: 'notice', facts: { legacy: 1 } })
  expect(readFileSync(old, 'utf8')).toBe('SYNTHETIC-CREDENTIAL')
  expect(readdirSync(join(home, '.mimir'))).toEqual(['store.json.pre-restore-old.bak'])
})
it('宽松私有目录报告保护失败而不自动收权', () => {
  const home = fixture()
  mkdirSync(join(home, '.mimir', 'restore-registry-snapshots'), { mode: 0o777 })
  expect(scanRegistrySnapshotProtection(home)).toMatchObject({ severity: 'error' })
})
it('实际新增快照可只读验证，结果不含合成凭据或路径', () => {
  const home = fixture()
  writeFileSync(join(home, '.mimir', 'store.json'), '{"settings":{"apiKey":"SYNTHETIC-CREDENTIAL"}}')
  appendWorkspaceRecord(home, { id: 'new', name: 'New', path: join(home, 'restored'), createdAt: 'c', updatedAt: 'u' })
  const result = scanRegistrySnapshotProtection(home)
  expect(result).toMatchObject({ severity: 'ok', facts: { verified: 1, legacy: 0 } })
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-CREDENTIAL')
  expect(JSON.stringify(result)).not.toContain(home)
})
