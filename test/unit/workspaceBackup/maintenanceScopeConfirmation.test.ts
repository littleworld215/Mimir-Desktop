import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { selectRestoreRequest } from '../../../electron/workspaceBackup/maintenanceSelection'
import { confirmSelectedRestoreScope } from '../../../electron/workspaceBackup/maintenanceScopeConfirmation'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mimir-scope-confirm-')); roots.push(home)
  const root = join(home, 'source'), archive = join(home, 'actual.zip'), parent = join(home, 'destination'), target = join(parent, 'new')
  mkdirSync(parent)
  mkdirSync(join(root, '.mimir'), { recursive: true })
  writeFileSync(join(root, '.mimir', 'store.json'), JSON.stringify({ 'library:papers': [{ pdfPath: 'Q:/actual-selected.pdf' }] }))
  await createBackup({ root, destination: archive, stagingDir: join(home, 'stage'), assetsDb: null })
  const selected = await selectRestoreRequest({ archivePath: 'Q:/old-suggestion.zip', targetRoot: target, spaceName: 'New' }, {
    pickArchive: async () => archive, pickTarget: async () => target
  })
  return { selected: selected!, archive, parent }
}
it('确认仅使用实际原生选择；取消不提供恢复许可', async () => {
  const f = await fixture()
  const result = await confirmSelectedRestoreScope(f.selected, { confirm: async summary => { expect(summary.externalCount).toBe(1); return 'cancel' }, showDetails: async () => 'back' })
  expect(result).toBeNull()
})
it('显式看说明后仍需继续，只有请求next才前进', async () => {
  const f = await fixture(); let calls = 0
  const result = await confirmSelectedRestoreScope(f.selected, {
    confirm: async () => ++calls === 1 ? 'details' : 'continue',
    showDetails: async page => { expect(page.items).toMatchObject([{ entry: { target: 'Q:/actual-selected.pdf' } }]); return 'back' }
  })
  expect(calls).toBe(2); expect(result?.externalCount).toBe(1)
})
it('确认阅读期间归档变化则拒绝，不沿用早先的继续意图', async () => {
  const f = await fixture()
  await expect(confirmSelectedRestoreScope(f.selected, {
    confirm: async () => { appendFileSync(f.archive, 'changed'); return 'continue' }, showDetails: async () => 'back'
  })).rejects.toThrow()
})
it('确认期间只替换目标父目录也拒绝，即使归档未变', async () => {
  const f = await fixture()
  await expect(confirmSelectedRestoreScope(f.selected, { confirm: async () => {
    renameSync(f.parent, f.parent + '-old'); mkdirSync(f.parent); return 'continue'
  }, showDetails: async () => 'back' })).rejects.toThrow()
})
