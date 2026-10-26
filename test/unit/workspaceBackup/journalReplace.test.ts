import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RestoreJournal } from '../../../electron/workspaceBackup/restoreJournal'

const control = vi.hoisted(() => ({ failures: 0, attempts: 0, code: 'EPERM', onFailure: undefined as ((file: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: (from: string, to: string) => {
    if (to.includes('restore-operations') && to.endsWith('.json')) {
      control.attempts++
      if (control.failures > 0) {
        control.failures--; control.onFailure?.(to)
        throw Object.assign(new Error('synthetic replacement error'), { code: control.code, syscall: 'rename' })
      }
    }
    fs.renameSync(from, to)
  } }
})
const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mimir-journal-replace-')); roots.push(home)
  mkdirSync(join(home, '.mimir'))
  const journal = new RestoreJournal(home), record = journal.create(join(home, 'restored'), '合成空间')
  const file = join(journal.directory, `${record.id}.json`), before = readFileSync(file)
  return { journal, record, file, before }
}
afterEach(() => {
  control.failures = 0; control.attempts = 0; control.code = 'EPERM'; control.onFailure = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('Windows瞬时原子替换拒绝可有界重试，只发布同一修订的完整文件', () => {
  const f = fixture(); control.failures = 2
  if (process.platform !== 'win32') { expect(() => f.journal.save(f.record, { phase: 'inspecting' })).toThrow(); return }
  const saved = f.journal.save(f.record, { phase: 'inspecting' })
  expect(saved.revision).toBe(1)
  expect(f.journal.read(f.record.id)).toMatchObject({ phase: 'inspecting', revision: 1 })
  expect(control.attempts).toBe(3)
  expect(readdirSync(f.journal.directory)).toEqual([`${f.record.id}.json`])
})

it('持续权限拒绝有限退出，原记录字节不变，暂存清理', () => {
  const f = fixture(); control.failures = 100
  expect(() => f.journal.save(f.record, { phase: 'inspecting' })).toThrowError(expect.objectContaining({ code: 'RECHECK_FAILED' }))
  expect(control.attempts).toBeLessThanOrEqual(4)
  expect(readFileSync(f.file)).toEqual(f.before)
  expect(readdirSync(f.journal.directory)).toEqual([`${f.record.id}.json`])
})

it('磁盘不足不得重试或覆盖原记录', () => {
  const f = fixture(); control.failures = 100; control.code = 'ENOSPC'
  expect(() => f.journal.save(f.record, { phase: 'inspecting' })).toThrow()
  expect(control.attempts).toBe(1)
  expect(readFileSync(f.file)).toEqual(f.before)
})

it('重试间目标被改写时拒绝覆盖，即使仍为同一修订', () => {
  const f = fixture(); control.failures = 1
  const replacement = Buffer.from(JSON.stringify({ ...f.record, spaceName: '外来写入' }))
  control.onFailure = file => writeFileSync(file, replacement)
  expect(() => f.journal.save(f.record, { phase: 'inspecting' })).toThrow()
  expect(control.attempts).toBe(1)
  expect(readFileSync(f.file)).toEqual(replacement)
})
