import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDoctorReport } from '../../../electron/workspaceBackup/doctorReport'
import { createBackup } from '../../../electron/workspaceBackup/packer'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mimir-doctor-scope-')); roots.push(home)
  const root = join(home, 'source'), path = join(home, 'scope.zip')
  mkdirSync(join(root, '.mimir'), { recursive: true })
  writeFileSync(join(root, '.mimir', 'store.json'), JSON.stringify({ 'library:papers': [{ pdfPath: 'Q:/SYNTHETIC-PRIVATE.pdf' }] }))
  await createBackup({ root, destination: path, stagingDir: join(home, 'staging'), assetsDb: null })
  const deps = { home, readRegistry: () => [], resolveSpaces: () => [], listArchives: async () => [{ path, name: 'scope.zip' }], scanResiduals: () => [] }
  return { deps }
}
it('内容验包通过仍独立报告已知外部依赖，不把范围摘要写进路径日志', async () => {
  const f = await fixture(), report = await buildDoctorReport(f.deps)
  expect(report.checks.find(c => c.id === 'ARCHIVE_VERIFY')).toMatchObject({ severity: 'ok' })
  expect(report.checks.find(c => c.id === 'ARCHIVE_SCOPE')).toMatchObject({ severity: 'warning', facts: { external: 1 } })
  expect(JSON.stringify(report)).not.toContain('Q:/SYNTHETIC-PRIVATE.pdf')
})
it('旧注入验证器只有验包成功时，范围仍标未知', async () => {
  const f = await fixture(), report = await buildDoctorReport({ ...f.deps, verifyArchive: async () => ({ entries: 2, totalBytes: 10, formatVersion: 1 }) })
  expect(report.checks.find(c => c.id === 'ARCHIVE_SCOPE')).toMatchObject({ severity: 'notice', facts: { unknown: 1 } })
})
it('无私有快照的只读自检接入检查但不构造凭据文件', async () => {
  const f = await fixture(), report = await buildDoctorReport(f.deps)
  expect(report.checks.find(c => c.id === 'REGISTRY_SNAPSHOT_PROTECTION')).toBeDefined()
})
