import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectRestoreRequest } from '../../../electron/workspaceBackup/maintenanceSelection'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g06-selection-')); roots.push(root)
  const parent = join(root, '新资料'); mkdirSync(parent)
  const archive = join(root, '已选.zip'); writeFileSync(archive, 'synthetic')
  return { root, parent, archive, target: join(parent, '新空间') }
}
it('uses only native picker results, never renderer path suggestions', async () => {
  const f = fixture()
  const selected = await selectRestoreRequest({ archivePath: join(f.root, 'forged.zip'), targetRoot: join(f.root, 'forged'), spaceName: '科研' }, {
    pickArchive: async () => f.archive, pickTarget: async () => f.target
  })
  expect(selected?.request).toEqual({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' })
  expect(() => selected!.assertUnchanged()).not.toThrow()
})
it('native cancellation creates no selection and does not call the next picker', async () => {
  const f = fixture(); let called = false
  expect(await selectRestoreRequest({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' }, {
    pickArchive: async () => undefined, pickTarget: async () => { called = true; return f.target }
  })).toBeNull()
  expect(called).toBe(false)
})
it('cancelled target does not authorize the suggested path', async () => {
  const f = fixture()
  expect(await selectRestoreRequest({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' }, {
    pickArchive: async () => f.archive, pickTarget: async () => undefined
  })).toBeNull()
})
it('归档已选后在目标对话框期间被替换必须拒绝，不能重新取基线', async () => {
  const f = fixture()
  await expect(selectRestoreRequest({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' }, {
    pickArchive: async () => f.archive,
    pickTarget: async () => { writeFileSync(f.archive, 'replaced while native target dialog was open'); return f.target }
  })).rejects.toThrow()
})
it('rejects extra request fields before opening native dialogs', async () => {
  let called = false
  await expect(selectRestoreRequest({ archivePath: 'a', targetRoot: 'b', spaceName: 'c', unsafe: true }, {
    pickArchive: async () => { called = true; return undefined }, pickTarget: async () => undefined
  })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(called).toBe(false)
})
it('rejects archive content changes and replaced parent identities', async () => {
  const f = fixture()
  const selected = await selectRestoreRequest({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' }, {
    pickArchive: async () => f.archive, pickTarget: async () => f.target
  })
  writeFileSync(f.archive, 'different contents')
  expect(() => selected!.assertUnchanged()).toThrow()
  const second = await selectRestoreRequest({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' }, {
    pickArchive: async () => f.archive, pickTarget: async () => f.target
  })
  renameSync(f.parent, f.parent + '-old'); mkdirSync(f.parent)
  expect(() => second!.assertUnchanged()).toThrow()
})
it('rejects selected existing targets and non-file archives', async () => {
  const f = fixture()
  const deps = { pickArchive: async () => f.parent, pickTarget: async () => f.target }
  await expect(selectRestoreRequest({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' }, deps)).rejects.toThrow()
  mkdirSync(f.target)
  await expect(selectRestoreRequest({ archivePath: f.archive, targetRoot: f.target, spaceName: '科研' }, { ...deps, pickArchive: async () => f.archive })).rejects.toThrow()
})
